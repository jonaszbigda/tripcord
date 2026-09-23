# repro — dashboard: accounts, orgs & self-serve keys design

Status: draft
Date: 2026-09-23
Scope: sub-project 4a — user accounts and login, orgs with members and invites, tenant
ownership of projects, and a dashboard SPA for self-serve project and API key
management. The timeline viewer (read API, list/filter/detail, charts) is sub-project
4b with its own spec. The marketing site at `reprojs.dev` is a separate, later
sub-project.

## Problem & concept

Projects and API keys can only be created by an operator with shell access
(`repro-admin`, see `2026-09-22-repro-api-keys-design.md`), and nothing records who
owns a project. repro is meant to run both as a hosted multi-tenant SaaS
(`app.reprojs.dev`) and as a single self-hosted container, so 4a adds:

- Users who log in with email and password, and optionally with GitHub.
- Orgs that own projects, with members in two roles (`owner`, `member`) and
  link-based invites.
- A dashboard SPA, served by the existing Fastify server, where members create
  projects and mint and revoke keys by calling the existing key service layer.

Tenant isolation is the property that must hold from day one: every dashboard read or
write is scoped to an org the caller belongs to.

### Deployment shape

- **SaaS:** `reprojs.dev` is the marketing site (separate sub-project, static
  hosting). `app.reprojs.dev` is this server: dashboard at `/`, JSON API at `/api/*`,
  ingest at `/v1/*`.
- **Self-host:** unchanged — one container from `docker compose up`, dashboard at `/`.
  No marketing page.

## Decisions

| Question | Decision |
| --- | --- |
| Tenancy | Orgs with members; users may belong to several orgs; projects belong to one org |
| Roles | `owner` and `member`. Members do everything except manage people and rename the org |
| Login | Email + password always available; GitHub OAuth enabled when configured |
| Signup | `SIGNUP=open` (SaaS) or `SIGNUP=invite-only` (self-host default; first user bootstraps) |
| Sessions | Server-side rows keyed by token hash; httpOnly cookie; fixed 30-day expiry |
| Password hashing | `node:crypto` `scrypt`, per-user random salt — no new dependency |
| Email | None in 4a. Invites are copyable links; password resets go through the CLI |
| Frontend | `dashboard/` workspace: Vite, React, TypeScript, React Router, TanStack Query, Tailwind v4 |
| Serving | Fastify serves the built SPA; one container |

## Data model (Postgres, via Drizzle)

### `users` (new)

| column          | type        | notes                                                        |
| --------------- | ----------- | ------------------------------------------------------------ |
| `id`            | uuid, PK    | `defaultRandom()`                                            |
| `email`         | text        | not null, unique. Stored trimmed and lowercased.            |
| `name`          | text        | not null, 1–100 characters                                   |
| `password_hash` | text        | nullable — `NULL` for users who only log in with GitHub      |
| `github_id`     | text        | nullable, unique. GitHub's numeric user id, as text.         |
| `created_at`    | timestamp   | not null, `defaultNow()`                                     |

`password_hash` format: `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>`, so cost
parameters can be raised later without invalidating existing hashes. Parameters:
N=2^15, r=8, p=1, 16-byte salt, 64-byte output. Verification uses
`crypto.timingSafeEqual`.

GitHub is a column, not an `oauth_accounts` table: there is one provider. Adding a
second provider later is one migration.

### `sessions` (new)

| column       | type                   | notes                                        |
| ------------ | ---------------------- | -------------------------------------------- |
| `token_hash` | text, PK               | SHA-256 (lowercase hex) of the cookie token  |
| `user_id`    | uuid, FK → `users.id`  | not null, indexed                            |
| `created_at` | timestamp              | not null, `defaultNow()`                     |
| `expires_at` | timestamp              | not null, `created_at + 30 days`             |

The cookie carries 32 random bytes, base64url-encoded. Only the hash is stored, as
with API keys, so a database leak exposes no live sessions. Expiry is fixed (not
sliding). The daily retention job also deletes expired sessions.

### `orgs` (new)

`id` (uuid PK), `name` (text, not null, 1–100 characters), `created_at`. Names are not
unique.

### `memberships` (new)

| column       | type                  | notes                                  |
| ------------ | --------------------- | -------------------------------------- |
| `org_id`     | uuid, FK → `orgs.id`  | PK part                                |
| `user_id`    | uuid, FK → `users.id` | PK part; indexed (for "my orgs")       |
| `role`       | text                  | `owner` or `member`                    |
| `created_at` | timestamp             | not null, `defaultNow()`               |

`role` is text rather than a Postgres enum, for the same reason as
`timelines.reason_type`: validity is enforced in code, and a new role is a code change.

### `invites` (new)

| column        | type                  | notes                                          |
| ------------- | --------------------- | ---------------------------------------------- |
| `id`          | uuid, PK              |                                                |
| `org_id`      | uuid, FK → `orgs.id`  | not null, indexed                              |
| `token_hash`  | text                  | not null, unique. SHA-256 of the invite token. |
| `role`        | text                  | role granted on acceptance                     |
| `created_by`  | uuid, FK → `users.id` | not null                                       |
| `created_at`  | timestamp             | not null, `defaultNow()`                       |
| `expires_at`  | timestamp             | not null, `created_at + 7 days`                |
| `accepted_at` | timestamp             | nullable                                       |
| `accepted_by` | uuid, FK → `users.id` | nullable                                       |
| `revoked_at`  | timestamp             | nullable                                       |

Invite tokens are `rpi_` + base64url of 32 random bytes. Invites are single-use and
not bound to an email address. The link is `${PUBLIC_URL}/invite/<token>` and is
shown once, at creation.

### `projects` (changed)

Gains `org_id` (uuid, FK → `orgs.id`, not null, indexed).

### Migration

One migration, generated by drizzle-kit and then hand-edited so that the `NOT NULL`
column can be added to a table that may already hold rows:

1. Create `users`, `sessions`, `orgs`, `memberships`, `invites`.
2. Add `projects.org_id` as nullable.
3. If any projects exist, insert one org named `Default` and set every project's
   `org_id` to it.
4. Set `projects.org_id` `NOT NULL`, add the FK and index.

Projects created with the CLI before this migration are kept, not dropped. The
`Default` org has no members until an instance is bootstrapped (see Signup).

## Authentication

### Signup — `POST /api/auth/signup`

Body `{ email, name, password, inviteToken? }`. Password: 8–256 characters, no
composition rules. Email: trimmed, lowercased, must contain one `@` with text on both
sides, max 254 characters.

Whether signup is allowed:

| `SIGNUP`      | No users yet (bootstrap) | Valid `inviteToken` | Otherwise |
| ------------- | ------------------------ | ------------------- | --------- |
| `open`        | allowed                  | allowed             | allowed   |
| `invite-only` | allowed                  | allowed             | `403 Signup is invite-only` |

An `inviteToken` that is present but not usable returns `404 Invite not found or
expired` in either mode; it never falls back to an ordinary signup.

What the new user gets:

- **With a valid invite:** membership of the invite's org with the invite's role; the
  invite is consumed in the same transaction. No personal org.
- **Bootstrap (the `users` table was empty):** ownership of every org that has no
  members — in practice the migrated `Default` org. If there is none, a personal org.
- **Otherwise:** a personal org named `<name>'s org`, as owner.

The bootstrap check and user insert run in one transaction holding a Postgres advisory
lock, so two concurrent "first" signups cannot both bootstrap. An email that already
exists returns `409 Email already registered`. A successful signup starts a session
(sets the cookie) and returns the same body as `GET /api/me`.

### Login and logout

- `POST /api/auth/login` `{ email, password }`. Unknown email and wrong password both
  return `401 Invalid email or password`. For an unknown email, or a user with no
  password, a scrypt hash is still computed against a fixed dummy hash so that
  response time doesn't reveal which emails exist.
- `POST /api/auth/logout` deletes the current session row and clears the cookie.
- Login and signup are rate-limited per client IP (10 requests per minute each) with
  the existing `@fastify/rate-limit`. `TRUST_PROXY` (default `false`) sets Fastify's
  `trustProxy` so the SaaS deployment sees real client IPs behind its proxy.

### GitHub OAuth

Enabled only when both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set.
`GITHUB_BASE_URL` (default `https://github.com`) supports GitHub Enterprise Server;
the API base is derived from it (`https://api.github.com` for github.com,
`<base>/api/v3` otherwise).

- `GET /api/auth/github?intent=login|connect[&invite=<token>]` sets a short-lived,
  httpOnly `state` cookie (random value plus intent and optional invite token) and
  redirects to GitHub's authorize URL with scope `read:user user:email`.
- `GET /api/auth/github/callback` checks `state` against the cookie, exchanges the
  code, then reads `/user` and `/user/emails`. The verified primary email is required;
  without one: `GitHub account has no verified email`.

Callback outcomes for `intent=login`:

| Situation                                              | Result |
| ------------------------------------------------------ | ------ |
| `github_id` belongs to a user                          | log in |
| no user has this `github_id`, but one has this email   | refuse: *An account with this email already exists. Log in with your password and connect GitHub from settings.* |
| neither exists                                         | create the user (no password) under the Signup rules above, including invite handling; name = GitHub `name` or `login` |

Auto-linking by email is refused on purpose: emails of password accounts are
unverified, so an attacker could register a victim's email in advance and would then
share the account once the victim signs in with GitHub.

For `intent=connect` (user must be logged in): set `github_id` on the current user.
If that GitHub account is already linked to another user: refuse with
`This GitHub account is linked to another user`.

The callback always ends with a redirect into the SPA (`/` on success, or
`/login?error=<code>` on failure, where the SPA maps the code to the messages
above). It never renders JSON.

### Account settings

- `POST /api/me/password` `{ currentPassword?, newPassword }`. `currentPassword` is
  required if the user has a password; a GitHub-only user can set a first password
  without it. Deletes all of the user's other sessions.
- `DELETE /api/me/github` disconnects GitHub. Refused with `409` if the user has no
  password, since they would be locked out.

### Cookies, CSRF and CORS

- Session cookie `repro_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when
  `PUBLIC_URL` is https. Handled with `@fastify/cookie` (new dependency).
- Every non-GET `/api/*` request must have `Content-Type: application/json` and an
  `Origin` header equal to `PUBLIC_URL`'s origin, else `403`. The GitHub endpoints
  are GETs and are protected by `state`. HTML forms cannot send JSON without a
  preflight, and there is no CORS on `/api`, so cross-site requests cannot pass.
- The existing permissive CORS registration (`origin: true`) is moved so it applies
  only to `/v1/*`. `/api/*` has no CORS headers.

## Authorization and API

A `requireUser` preHandler resolves the session cookie to a user (missing, unknown or
expired → `401 Not logged in`). Every tenant-scoped route is under
`/api/orgs/:orgId/…` and uses `requireMembership(minRole)`:

- Not a member of `:orgId` (or `:orgId` doesn't exist or isn't a UUID) → `404 Not
  Found`, so org ids can't be probed.
- Member without the required role → `403 Forbidden`.

Membership is read on every request, not cached in the session, so removing a member
takes effect on their next request. Handlers take tenant ids only from the URL, never
from the body, and every nested resource (project, key, invite, member) is looked up
together with its `org_id`; a resource in another org is `404`.

### Routes

| Method & path | Role | Purpose |
| --- | --- | --- |
| `GET /api/auth/config` | public | `{ signup: "open" \| "invite-only", bootstrapped: boolean, github: boolean }` — drives the login/signup UI |
| `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout` | public | see Authentication |
| `GET /api/auth/github`, `GET /api/auth/github/callback` | public | see GitHub OAuth |
| `GET /api/me` | user | `{ user: { id, email, name, hasPassword, githubConnected }, orgs: [{ id, name, role }] }` |
| `POST /api/me/password`, `DELETE /api/me/github` | user | account settings |
| `POST /api/orgs` | user | create an org; caller becomes owner |
| `PATCH /api/orgs/:orgId` | owner | rename |
| `GET /api/orgs/:orgId/members` | member | list members: id, name, email, role, joined |
| `PATCH /api/orgs/:orgId/members/:userId` | owner | change role |
| `DELETE /api/orgs/:orgId/members/:userId` | owner, or the member themself (leave) | remove |
| `POST /api/orgs/:orgId/invites` | owner | `{ role }` → invite plus its link, shown once |
| `GET /api/orgs/:orgId/invites` | owner | pending (unaccepted, unrevoked, unexpired) invites |
| `DELETE /api/orgs/:orgId/invites/:inviteId` | owner | revoke |
| `GET /api/invites/:token` | public | `{ orgName, role }` for a usable invite |
| `POST /api/invites/:token/accept` | user | join the org |
| `GET /api/orgs/:orgId/projects` | member | projects with active key counts |
| `POST /api/orgs/:orgId/projects` | member | `{ name }` → project plus first key, key shown once |
| `GET /api/orgs/:orgId/projects/:projectId/keys` | member | list keys (never hashes) |
| `POST /api/orgs/:orgId/projects/:projectId/keys` | member | mint a key, shown once |
| `POST /api/orgs/:orgId/projects/:projectId/keys/:keyId/revoke` | member | revoke (idempotent, as in the CLI) |

All request bodies are validated with Fastify JSON schemas (`additionalProperties:
false`, as for ingest).

### Rules

- **Every org keeps at least one owner.** Demoting, removing, or leaving as the last
  owner → `409 An org must have at least one owner`. Checked inside the same
  transaction as the change, with the org's membership rows locked (`FOR UPDATE`).
- **Invites:** a used, revoked or expired token → `404 Invite not found or expired`
  (the three are not distinguished). Accepting when already a member →
  `409 Already a member`, and the invite stays unused. Acceptance marks the invite
  used with a conditional update (`accepted_at IS NULL`), so a token can't be
  accepted twice concurrently.
- **Org deletion and project deletion** are not available (see Out of scope).

### Reusing the key service (`server/src/db/projects.ts`)

Key generation and hashing stay where they are. Changes:

- `createProject(db, orgId, name)` gains `orgId`.
- `listProjects(db, { orgId? })` gains an optional org filter; the CLI omits it and
  sees all projects, now with their org.
- New `findProjectInOrg(db, orgId, projectId)` and
  `findApiKeyInOrg(db, orgId, projectId, keyId)`. Routes call these first and return
  `404` if they miss, then call the existing `createApiKey`, `listApiKeys` and
  `revokeApiKey` unchanged.

New service modules follow the same pattern (`db` passed in, plain return values,
`undefined` for not-found): `server/src/db/users.ts`, `sessions.ts`, `orgs.ts`
(orgs, memberships), `invites.ts`. Pure primitives live beside `keys.ts`:
`server/src/auth/password.ts` (scrypt hash/verify) and `server/src/auth/tokens.ts`
(session and invite token generation). Routes live in `server/src/routes/`:
`auth.ts`, `me.ts`, `orgs.ts`, `invites.ts`, `projects.ts`.

### Errors

Same `{ error }` envelope as ingest.

| Status | Meaning |
| --- | --- |
| `400` | validation failed |
| `401` | not logged in / invalid credentials |
| `403` | member without the required role; signup closed; CSRF check failed |
| `404` | not found, or not a member of the org |
| `409` | last-owner rule; already a member; email already registered; GitHub disconnect would lock out |
| `429` | login/signup rate limit |

## CLI changes

`repro-admin` (in `server/src/admin.ts`) is for bootstrap and recovery; the dashboard
is now the primary path.

```
repro-admin org list                                id, name, members, projects
repro-admin project create --org <orgId> <name>     --org now required
repro-admin project list                            gains an org column
repro-admin user reset-password <email>             prints a generated password once,
                                                    deletes all the user's sessions
```

New error rows: `Org not found: <id>` (exit 1), `User not found: <email>` (exit 1),
missing `--org` (exit 2, with usage). The generated password is 24 base64url
characters from `crypto.randomBytes`.

## Dashboard SPA (`dashboard/` workspace)

Vite + React + TypeScript, sharing the root tsconfig and eslint base. Added to root
`workspaces`.

- **Routing:** React Router.
- **Data:** TanStack Query; mutations invalidate the lists they affect (e.g. revoking
  a key refreshes the key list). A small `api()` fetch wrapper sends JSON, reads the
  `{ error }` envelope into a thrown error, and redirects to `/login` on `401`.
- **Styling:** Tailwind CSS v4 via `@tailwindcss/vite`. Design tokens (colors,
  radius, font) are declared once in `@theme`, with light and dark values, so they
  are also available as CSS variables — the 4b charts read their colors from them.
  No component library.

Pages:

| Path | Page |
| --- | --- |
| `/login` | email/password form; "Sign in with GitHub" when enabled; link to signup when allowed |
| `/signup` | reachable when `signup === "open"`, the instance isn't bootstrapped, or coming from an invite link |
| `/invite/:token` | org name and role; accept if logged in, otherwise log in / sign up (the token is carried through, including GitHub's `invite` param) |
| `/orgs/:orgId/projects` | project list, create project |
| `/orgs/:orgId/projects/:projectId` | keys: list, create, revoke; the ingest endpoint (`${PUBLIC_URL}/v1/timeline`); a placeholder area for 4b's timelines |
| `/orgs/:orgId/members` | members and roles; pending invites and "create invite" (owner-only controls hidden for members) |
| `/orgs/:orgId/settings` | rename org (owners) |
| `/settings` | name/email shown; set or change password; connect or disconnect GitHub |
| `/` | redirect to the first org's projects |

An org switcher in the header lists the user's orgs and has "New org". Newly created
API keys and invite links appear once, in a panel with a copy button and a "this won't
be shown again" warning, matching the CLI.

## Serving

- `@fastify/static` (new dependency) serves the built SPA from `DASHBOARD_DIR`
  (default: `../dashboard/dist` relative to the server's `dist/`). If the directory
  doesn't exist — tests, or the server run on its own in dev — static serving is
  skipped.
- Any GET that isn't under `/api`, `/v1` or `/health` and doesn't match a static
  file returns `index.html`, so client-side routes survive a reload. Unknown `/api/*`
  and `/v1/*` paths still return the JSON `404`.
- **Dev:** `npm run dev -w dashboard` starts Vite with a proxy for `/api` to
  `http://localhost:3000`.
- **Docker:** the Dockerfile's build stage also builds `dashboard`, and the runtime
  stage copies `dashboard/dist`. Still one container. `docker-compose.yml` sets
  `PUBLIC_URL: http://localhost:3000`.

## Configuration (new)

| Var | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:3000` | external origin; used for the CSRF `Origin` check, cookie `Secure`, invite links, OAuth callback |
| `SIGNUP` | `invite-only` | `open` or `invite-only`; any other value fails startup |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | unset | enable GitHub login when both are set; one without the other fails startup |
| `GITHUB_BASE_URL` | `https://github.com` | GitHub Enterprise Server support |
| `TRUST_PROXY` | `false` | Fastify `trustProxy`, for correct client IPs behind a proxy |
| `DASHBOARD_DIR` | see Serving | location of the built SPA |

The GitHub OAuth App's callback URL is `${PUBLIC_URL}/api/auth/github/callback`.

## Testing

Existing setup: Vitest, testcontainers Postgres, `app.inject`, each test cleans up its
own rows.

- **Test helpers** in `server/test/db.ts`: `createTestUser`, `createTestOrg`
  (optionally with members and roles), and `loginAs(app, user)` returning a cookie
  header. `createTestProject` creates an org if none is given.
- **Units (no DB):** scrypt hash/verify round trip, wrong password fails, encoded
  parameters are honored; token generation formats.
- **Auth:** signup in both modes; bootstrap takes ownership of the memberless
  `Default` org; two concurrent bootstrap signups produce exactly one bootstrap;
  duplicate email; login success and generic failure for unknown email and wrong
  password; expired session → `401`; logout invalidates the session; password change
  kills other sessions; login rate limit.
- **CSRF:** a POST without JSON content type, or with a foreign or missing `Origin`,
  → `403`. No `Access-Control-Allow-Origin` on `/api/*`; unchanged CORS on `/v1/*`.
- **Tenant isolation:** a table-driven test lists every org-scoped route and calls
  each one as a logged-in user from a different org, expecting `404`. It also checks
  that the route list covers every registered `/api/orgs/...` route (read from
  Fastify's route table), so a new route without an entry fails the test.
- **Roles:** every owner-only route returns `403` for a member; the last-owner rule
  on demote, remove and leave.
- **Invites:** create → accept; single-use; expired; revoked; already a member;
  concurrent double-accept gives one success; signup with an invite in
  `invite-only` mode.
- **Projects and keys over HTTP:** create project returns a key that works on
  `POST /v1/timeline`; revoke via the dashboard route makes ingest return `401`.
- **GitHub:** `buildApp` accepts an injectable `fetch` for GitHub calls; tests stub
  it. Cases: new user; existing link logs in; email collision refused; no verified
  email refused; bad `state` refused; connect; connect to an already-linked GitHub
  account refused; disconnect blocked without a password.
- **Migration:** a database with pre-existing projects ends up with them in a
  `Default` org; an empty database creates no org.
- **CLI:** `org list`, `project create --org`, `user reset-password` through
  `runCli`, including the new error rows.
- **Dashboard:** Vitest + Testing Library (jsdom) with a mocked `fetch`: a new key
  and a new invite link are shown once and gone after navigating away; owner-only
  controls hidden for members; a `401` redirects to `/login`; signup link visibility
  follows `/api/auth/config`.
- No browser end-to-end suite. Final check is a manual docker-compose smoke test:
  bootstrap signup, create project, send a timeline with the key, invite a second
  user, revoke the key.

## Docs

- `server/README.md`: new env vars; first-run bootstrap; setting up a GitHub OAuth
  App; the CLI's new role (recovery) and commands.
- Root `README.md`: add the `dashboard` workspace.
- `2026-09-22-repro-api-keys-design.md`: out-of-scope entries for tenancy and login
  point to this spec.

## Explicitly out of scope

- The timeline viewer, its read API and charts — sub-project 4b.
- The marketing site at `reprojs.dev` — separate sub-project.
- Any email: verification, password reset, invite delivery.
- Deleting orgs, projects or user accounts; transferring projects between orgs.
- `last_used_at` on API keys.
- OAuth providers other than GitHub.
- An instance-admin UI (operators use the CLI).
- Session listing / "log out other devices" UI (password change does it implicitly).
