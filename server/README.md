# @repro/server

The ingest API for `repro`. It receives the timelines that `@repro/js` (the browser
client) sends when something goes wrong, validates them, and stores them in Postgres
behind a per-project API key. It also serves the dashboard (`dashboard/` in this
repo), where people sign up, create projects and manage API keys.

## Running it

The simplest way to run the server plus its Postgres database is `docker compose`
from the repo root:

```bash
docker compose up -d --build
```

This starts a `postgres` container and a `server` container (built from
[`Dockerfile`](Dockerfile)), runs pending migrations automatically on boot, and
exposes the API on `http://localhost:3000`.

Check it's alive:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Tear it down (including the Postgres volume) with:

```bash
docker compose down -v
```

To run the server directly with Node instead (e.g. for local development against
a Postgres you're already running):

```bash
npm install
npm run build -w server
DATABASE_URL=postgres://repro:repro@localhost:5432/repro npm run start -w server
```

## First run: create the first account

Open `http://localhost:3000`. On a fresh instance, signup is open for exactly one
person. The first account created becomes the instance's first org owner. If
projects existed before accounts did, they sit in a `Default` org, and the first
account becomes its owner.

After that, with the default `SIGNUP=invite-only`, people join only through invite
links, which org owners create on the **Members** page. Set `SIGNUP=open` to let
anyone who can reach the instance sign up; each new user gets their own org.

### GitHub login (optional)

1. Create a GitHub OAuth App (GitHub → Settings → Developer settings → OAuth Apps).
   Set **Authorization callback URL** to `<PUBLIC_URL>/api/auth/github/callback`,
   e.g. `http://localhost:3000/api/auth/github/callback`.
2. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the server. For GitHub
   Enterprise Server, also set `GITHUB_BASE_URL`.

Users can then sign in with GitHub, or connect GitHub to an existing account in
their settings. A GitHub login is never linked to an existing account by email
automatically.

### Developing the dashboard

Run the server with `PUBLIC_URL=http://localhost:5173`, then run
`npm run dev -w dashboard`. Vite proxies `/api` to the server on port 3000, and the
server's same-origin check expects requests from the Vite origin.

## The admin CLI

Day-to-day, projects and keys are created in the dashboard. The admin CLI in the
server image is for bootstrap and recovery. Keys are stored hashed, so a key is
printed **once**, when it's created.

Find the org id with `org list`.

With `docker compose`:

```bash
docker compose exec server node server/dist/cli.js project create --org <orgId> "your-project-name"
# Created project "your-project-name" (<project-id>)
# rpk_...
# Store this API key now. It will not be shown again.
```

Or locally, against a Postgres you're already running:

```bash
DATABASE_URL=postgres://repro:repro@localhost:5432/repro \
  npm run admin -w server -- project create --org <orgId> "your-project-name"
```

Use the printed `rpk_...` key as the `apiKey` passed to `init()` in `@repro/js`; it's
sent as the `X-Repro-Key` header.

All commands:

| Command                                 | What it does                                                   |
| ---------------------------------------- | -------------------------------------------------------------- |
| `org list`                              | List orgs with member and project counts.                      |
| `project create --org <orgId> <name>`   | Create a project in an org, with its first API key.            |
| `project list`                          | List projects with their org and number of active keys.        |
| `key create <projectId>`                | Mint an additional key for a project.                          |
| `key list <projectId>`                  | List a project's keys (prefix, created, revoked).              |
| `key revoke <keyId>`                    | Revoke a key. Ingest rejects it immediately.                   |
| `user reset-password <email>`           | Print a new random password once and log the user out everywhere. |

To rotate a key without dropping events: `key create`, deploy the new key to your
app, then `key revoke` the old one.

The CLI applies any pending database migrations before running a command, so it
works on a fresh database before the server has started. Run any command with
`--help` (or `-h`) to print the usage.

### Upgrading from a version before API key hashing

Older versions stored one plaintext key per project in `projects.api_key`. The
migration that introduces hashed keys **drops that column without carrying keys
over**, so after upgrading every existing key is rejected with `401`. The browser
client doesn't surface failed sends, so this is silent on the app side.

After upgrading, for each existing project:

1. `project list` to find it. Projects from before the upgrade show `0` active keys.
2. `key create <projectId>` to mint a new key.
3. Deploy the new key to the app's `init({ apiKey })` config.

## Environment variables

| Variable            | Required | Default        | Description                                                              |
| -------------------- | -------- | -------------- | -------------------------------------------------------------------------- |
| `DATABASE_URL`        | yes      | —              | Postgres connection string.                                              |
| `PORT`                | no       | `3000`         | Port the HTTP server listens on.                                          |
| `RETENTION_DAYS`      | no       | `30`           | Timelines older than this many days are deleted by the retention job.     |
| `RATE_LIMIT_MAX`      | no       | `100`          | Max `POST /v1/timeline` requests per project per `RATE_LIMIT_WINDOW`.     |
| `RATE_LIMIT_WINDOW`   | no       | `1 minute`     | Rate-limit window, as a string `@fastify/rate-limit` understands.         |
| `BODY_LIMIT_BYTES`    | no       | `262144` (256 KiB) | Max accepted request body size, in bytes.                            |
| `LOG_LEVEL`           | no       | `info`         | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`).       |
| `PUBLIC_URL`           | no       | `http://localhost:3000` | The dashboard's external URL. Used for the same-origin check on `/api`, `Secure` cookies (when https), invite links and the GitHub callback. |
| `SIGNUP`               | no       | `invite-only`  | `invite-only` (first user, then invite links) or `open` (anyone can sign up). |
| `GITHUB_CLIENT_ID`     | no       | —              | With `GITHUB_CLIENT_SECRET`, enables GitHub login.                        |
| `GITHUB_CLIENT_SECRET` | no       | —              | See above. Setting only one of the two fails startup.                     |
| `GITHUB_BASE_URL`      | no       | `https://github.com` | GitHub Enterprise Server URL.                                       |
| `TRUST_PROXY`          | no       | `false`        | Set `true` behind a reverse proxy so login and invalid-key limits see client IPs. |
| `DASHBOARD_DIR`        | no       | `../dashboard/dist` next to the server | Where the built dashboard is served from.         |

## API

`POST /v1/timeline` — accepts a timeline payload (see `@repro/js`'s `TimelinePayload`
type), authenticated via the `X-Repro-Key` header. Returns `201 { id }` on success.
It accepts an optional `tags` array (at most 10 tags, each matching
`^[a-z0-9][a-z0-9_.:-]{0,49}$`).

`GET /health` — liveness check, always `200 { status: "ok" }`.

`/api/*` holds the dashboard's JSON API. It's cookie-authenticated, same-origin only,
and has no CORS. See `docs/superpowers/specs/2026-09-23-repro-dashboard-accounts-design.md`.

The timeline viewer reads through `GET /api/orgs/:orgId/projects/:projectId/timelines`
(filtered, keyset-paginated list), `…/timelines/summary` (volume buckets and top
reasons), `…/timelines/tags` and `…/timelines/:timelineId`. Any member of the org
can call them. See `docs/superpowers/specs/2026-09-23-repro-dashboard-timelines-design.md`.

Every error response, on any route, is `{ "error": "message" }` — 4xx bodies include
a client-facing reason (e.g. a validation failure), 5xx bodies are deliberately
generic (`"Internal Server Error"`) and never leak internal error text.

## Development

```bash
npm test -w server        # vitest, spins up Postgres via testcontainers
npm run build -w server    # tsc
npm run typecheck -w server
npm run lint -w server
```

`npm run build`/`typecheck` first rebuild `@repro/js` (via `prebuild`/`pretypecheck`
hooks), since this package's types depend on its built `dist/`.

## License

MIT — see [`../LICENSE`](../LICENSE).
