# Tripcord — hosted beta design

Status: draft
Date: 2026-09-24
Scope: running Tripcord at `app.tripcord.dev` for people outside the project, with
enough in place that they can trust it with a production app. This covers signup
invites for new accounts, email and password reset, deleting projects, orgs and
accounts, exporting a project's timelines, a landing site at `tripcord.dev` with
written commitments and a privacy page, off-site backups, and the operations
checklist for the author's bare-metal server. No billing and no quotas.

## Problem & concept

Tripcord is released: the client is on npm and the server image is on GHCR. The
next step is to host it for other people. The worry isn't missing features. It's
that people won't put a beta product into a production app unless they're
confident about four things:

1. **It can't break their app.** This is already true: the client sends with
   `fetch(..., { keepalive: true }).catch(...)`, never throws and never retries.
   Nothing says so where a newcomer would read it.
2. **Their data survives.** Deploys can't wipe data. Postgres lives in a named
   volume, and migrations only move forward, behind an advisory lock. But backups
   are a local `pg_dump`, and a disk failure on the one server loses everything.
3. **They can leave.** The code is open and self-hostable, but there's no way to
   export timelines or delete a project, an org or an account. Leaving means
   asking the author by hand.
4. **They know what's promised.** Nothing is written down.

This sub-project closes those gaps without building a SaaS. The hosted instance
runs the same image self-hosters run. Every code change here ships in that image
and is useful to self-hosters too. The rest is a landing site that states the
commitments, and an operations checklist that makes them true.

The author has decided that paid plans, if they ever come, will keep a generous
free tier, so nobody is locked out of their own data. The commitments page says
so.

## Decisions

| Question | Decision |
| --- | --- |
| Hosted or SaaS | A hosted beta: the released image, invite-only, free. No billing, quotas or plans. |
| Domains | `tripcord.dev` is the landing site. `app.tripcord.dev` is the hosted instance (dashboard and ingest). `status.tripcord.dev` is the status page. |
| Who can sign up | Invite-only. New users come through **signup invites**, which the operator creates with the admin CLI. The landing page has a "Request access" mailto link. |
| Email | Optional SMTP (`SMTP_URL`, `EMAIL_FROM`), through `nodemailer`. It's used for password reset and, optionally, for sending signup invites. Without SMTP, both features are hidden and the admin CLI remains the fallback. |
| Email verification | Not in this sub-project. Every hosted user comes through an invite the operator sent, so addresses are known. It's required before `SIGNUP=open` on a public instance. |
| Deletion | Hard deletes in a transaction, done explicitly in code in dependency order. Soft deletes are kept only for API keys, as today. |
| Export | NDJSON, one timeline per line, per project, streamed. |
| Landing site | A new `site/` workspace in this monorepo: static HTML built with Vite and Tailwind, using the dashboard's design tokens and no framework. It's hosted on GitHub Pages, so it and the status page stay up when the server doesn't. |
| Where the site's code lives | This repo. The site shows the dashboard's look, the client's API and its screenshot, so one commit can change a feature and its copy together. It's private (never published), and path-filtered workflows keep it out of the way. It moves to its own repo if it outgrows this one, e.g. a blog or outside writers. |
| Hosting providers | The server is OVH, in France. Email is an OVH mailbox on `tripcord.dev`: its SMTP sends, and it receives mail for the contact address. Backups go to **Backblaze B2**, a different provider from the server, so an account or datacenter problem at OVH can't take the backups too. restic talks to B2 through its S3-compatible API. |
| Server version | `0.2.0`: new endpoints and migrations. The client is unchanged. |

## Signup invites

Today an invite adds someone to an existing org. A beta user needs their own
account in their own org, and `invite-only` has no way to create that, apart from
the bootstrap signup.

**Schema.** `invites.org_id` becomes nullable. A row with `org_id` NULL is a
**signup invite**, and its `role` is `owner`. Signing up with one works exactly
like an open-mode signup: the new user gets a personal org (`"<name>'s org"`), and
the invite is consumed in the same transaction. `signUp()` in `accounts.ts` already
branches on `invite`, so the change is small: a signup invite skips `addMember`
and falls through to the personal-org path.

**Accepting while logged in.** An existing user can't accept a signup invite. The
invite is for new accounts, so `POST /api/invites/:token/accept` returns
`409 { error: "This invite is for creating a new account" }`. The invite page
explains this and offers to log out.

**`GET /api/invites/:token`** returns `org: null` for a signup invite. The invite
page then says "You're invited to Tripcord" instead of naming an org.

**Admin CLI:**

| Command | What it does |
| --- | --- |
| `invite create [--email <address>]` | Create a signup invite (7-day expiry, same as org invites) and print its link once. With `--email` and SMTP configured, it also sends the link. |
| `invite list` | List pending signup invites: id, created, expires. |
| `invite revoke <inviteId>` | Revoke a pending signup invite. |

`created_by` is NULL for invites made by the CLI (see the migration under
[Deletion](#deletion)). Org invites are unchanged. Org owners can't create signup
invites from the dashboard. That decision belongs to the operator.

## Email

**Configuration.** Two variables, set together or not at all. Setting only one
fails startup, the same rule as the GitHub pair:

| Variable | Example | Meaning |
| --- | --- | --- |
| `SMTP_URL` | `smtps://user:pass@smtp.example.com:465` | nodemailer connection URL |
| `EMAIL_FROM` | `Tripcord <no-reply@tripcord.dev>` | From header |

`nodemailer` is pure JS with no install scripts, so the image still builds on the
build platform (see the Dockerfile's `build` stage).

**Messages** are plain text only: a greeting, one link, the link's expiry, and a
line saying what to do if the reader didn't ask for this. There are no templates
or HTML, which keeps deliverability good and the code small. The two messages are
"Reset your Tripcord password" and "You're invited to Tripcord".

**Failures.** Sending runs after the response has been sent, and errors are
logged, never shown to the requester. That also means the response time doesn't
reveal whether an email address has an account.

**`GET /api/auth/config`** gains `passwordReset: boolean`, which is true when SMTP
is configured. The login page shows "Forgot password?" only then.

## Password reset

**Table `password_resets`:** `token_hash` (PK, SHA-256 of a `tpr_` token from
`generateToken`), `user_id` (FK), `created_at`, `expires_at` (one hour), and
`used_at`.

**`POST /api/auth/password-reset`** takes `{ email }` and always returns `204`,
whether or not the account exists.
- If the email belongs to a user, delete that user's unused tokens, create a new
  one, and send `${PUBLIC_URL}/reset-password/<token>`.
- Per user, no new token within 2 minutes of the last one. Per IP, the same limit
  as login.
- GitHub-only users get a reset link too. Using it sets their first password,
  which they can already do from settings.

**`POST /api/auth/password-reset/confirm`** takes `{ token, newPassword }`, and
`newPassword` follows the same rules as `/api/me/password`.
- If the token is unknown, expired or used, return `400 { error: "This reset link
  is invalid or has expired" }`.
- Otherwise, in one transaction: set the password, mark the token used, and delete
  all of the user's sessions. Return `204`. The dashboard sends the user to login
  with a notice. It doesn't log them in automatically, so a leaked link alone never
  becomes a session.
- The per-IP limit is the same as login.

**Cleanup.** The retention job also deletes `password_resets` rows that expired
more than a day ago.

**Dashboard:** `/reset-password` (enter an email, then "If that address has an
account, we've sent a link") and `/reset-password/:token` (new password twice).
The token-in-path pattern matches `/invite/:token`.

## Deletion

All deletes are hard deletes, in one transaction, in dependency order. The
foreign keys have no `ON DELETE` actions, and that stays, so a forgotten
dependency fails loudly instead of silently removing rows.

**Migration.** `invites.created_by` becomes nullable. When a user is deleted,
`created_by` and `accepted_by` on invites they touched are set to NULL, which
keeps the invite history of orgs that remain.

**Project:** `DELETE /api/orgs/:orgId/projects/:projectId`, owner only. Deletes
the project's timelines, API keys and the project, then returns `204`. Ingest
with one of its keys gets `401` right away, as for a revoked key.

**Org:** `DELETE /api/orgs/:orgId`, owner only. Deletes every project as above,
then the org's invites, memberships and the org, and returns `204`. Former members
keep their accounts. If that was their only org, `HomePage` already sends them to
`/orgs/new`.

**Account:** `DELETE /api/me` takes `{ password? }`.
- Users with a password must give it (`403` if it's wrong). GitHub-only users
  confirm in the dashboard by typing their email. The server doesn't check that.
- For each org where the user is the **only owner**:
  - If it has other members, the request fails with
    `409 { error: "…", orgs: [{ id, name }] }`, and the dashboard lists those orgs:
    "Make someone else an owner, or delete the org."
  - If the user is the only member, the org is deleted along with the account.
- Then, in the same transaction: the user's memberships, sessions and password
  resets are deleted, invite references are set to NULL, and the user row is
  deleted. The session cookie is cleared, and the response is `204`.

**Admin CLI**, for support requests: `user delete <email>` and
`org delete <orgId>`. Both print what will be deleted (projects, number of
timelines, members) and require `--yes`.

**Dashboard.** Each page gets a "Danger zone" section, where the button is enabled
only after the confirmation name is typed:
- Project: a new **Settings** tab next to Timelines and Keys, with Export and
  Delete project. Confirm by typing the project name.
- Org: on `OrgSettingsPage`, owners only. Confirm by typing the org name.
- Account: on `UserSettingsPage`. Password users confirm with their password,
  GitHub-only users by typing their email.

**Scale.** A project's timelines are deleted in one statement. At beta volumes,
with 30-day retention and the per-project rate limit, that's a few hundred
thousand rows at most. Batching can wait until someone's project is larger than
that.

## Export

`GET /api/orgs/:orgId/projects/:projectId/export`, for any member.

- `Content-Type: application/x-ndjson`, and
  `Content-Disposition: attachment; filename="<project-slug>-<YYYY-MM-DD>.ndjson"`.
- Each line is one timeline, in the same shape as the timeline detail API:
  `{ id, sessionId, receivedAt, reasonType, reason, events, meta, tags }`.
- Keyset-paged by `(received_at, id)`, 500 rows at a time, written to the response
  as it goes, so memory stays flat.
- The dashboard's Export button is a plain link, so the browser handles the
  download.

It covers timelines only. Accounts, orgs and projects are small, and the user
can see them in the dashboard.

## Landing site (`site/`)

A new workspace, `@tripcord/site`, which is private and never published. Vite
multi-page build, Tailwind v4, no framework and almost no JavaScript (only a copy
button on the code snippet). The dashboard's tokens (colors, fonts, the cord
motif) move from `dashboard/src/index.css` into `dashboard/src/theme.css`, which
both apps import, so the site and the dashboard look like one product.

**Pages:**
- **`/`**, the home page. Its copy is written for both debugging and analytics
  users, and claims only what's built.
  - Hero: "No noise, pure signal." The two questions: why did this break, and how
    did people get here.
  - How it works: `npm i @tripcord/js`, `init()`, `capture()`, in three short
    steps with a code snippet.
  - The dashboard screenshot (`docs/dashboard.png`).
  - **Safe for production**: the client never throws or retries, and your app
    doesn't notice if Tripcord is down. Query strings and fragments are dropped
    from URLs by default. Only what you choose to record is sent.
  - Open source and self-hostable, with a link to the guide.
  - Calls to action: "Request access" (mailto) and "Self-host it" (the guide on
    GitHub).
- **`/beta/`**: the commitments (below).
- **`/privacy/`**: the privacy page (below).
- The footer links GitHub, npm, the status page, the self-hosting guide, and the
  contact address.

The site has no analytics, cookies or third-party scripts. Fonts are self-hosted
through `@fontsource`, as in the dashboard.

**Hosting.** GitHub Pages, deployed by `.github/workflows/site.yml` on pushes to
`main` that touch `site/**` or `dashboard/src/theme.css`. A `CNAME` file sets
`tripcord.dev`. CI builds the site as part of `npm run build`, so a broken site
fails CI before it's deployed.

### Commitments (`/beta/`) — draft copy, for the author to approve

- **Your app comes first.** The client never throws, never retries, and never
  blocks your page. If Tripcord is down, your users don't notice.
- **Your data is backed up.** Every night, encrypted, to storage separate from the
  server, kept for 14 days. Restores are tested. Timelines are kept for 30 days.
- **Deploys never remove data.** Database migrations only move forward. Anything
  that would drop data gets announced first.
- **There will always be a free tier.** Tripcord is free during the beta. If paid
  plans come, you get 30 days' notice and a generous free tier. Paid plans add
  capacity. They never lock you out of data you already have, and export is
  available on every plan.
- **You can leave at any time.** Export a project's timelines as NDJSON, and
  delete projects, orgs or your account from the dashboard. Deleted data is gone
  from the database immediately, and from backups within 14 days. Tripcord is open
  source, and the hosted version runs the same image you can self-host.
- **The API stays stable.** `/v1/timeline` and `@tripcord/js` 0.x stay backward
  compatible. A breaking change would get a new endpoint version, and the old one
  keeps working for at least 6 months.
- **If the service ever shuts down**, you get 60 days' notice, an export, and the
  self-host path.
- **What "beta" means.** It runs on one server, and there's no uptime SLA. Incidents
  are posted on the status page.

### Privacy page (`/privacy/`) — outline

- **What's stored:**
  - Accounts: email, name, password hash, and GitHub user id if connected.
  - Timelines: whatever your app records, plus the page URL (origin and path by
    default) and the browser's user agent.
  - No IP addresses are stored, with timelines or in the server's logs. Rate
    limits use them briefly, in memory. The logs also never hold invite or
    reset tokens.
- **Where it's stored:** on a server at OVH in France. Encrypted backups are
  stored with Backblaze (B2), in the bucket's region.
- **Subprocessors:** OVH (server and email), Backblaze (backups), and GitHub
  (GitHub Pages for this site, and OAuth if you log in with GitHub).
- **Never:** selling data, advertising, or tracking on this site.
- **Retention and deletion:** as in the commitments.
- **Contact:** the contact address.

A formal DPA is out of scope. The page says to email for one.

## Off-site backups (`deploy/backup.sh`)

A script for any self-hoster, run from cron on the host next to
`deploy/docker-compose.yml`:

1. `docker compose exec -T postgres pg_dump -Fc` writes to a temporary file.
2. `restic backup` sends it to the repository in `RESTIC_REPOSITORY`. restic
   encrypts it with `RESTIC_PASSWORD` and supports S3-compatible storage, SFTP and
   others.
3. `restic forget --keep-daily 14 --prune`.
4. It exits non-zero on any failure, so cron mail or a heartbeat monitor notices.
   An optional `BACKUP_HEARTBEAT_URL` is pinged on success.

The self-hosting guide's Backups section gains "Off-site backups" (setting up
restic, the cron line) and "Restore drill": restore into a throwaway Postgres
container and compare row counts.

## Operations checklist (not code)

This is done by the author before the first invite. The runbook for the hosted
instance lives outside this public repo: it describes one specific server, which
self-hosters don't need and attackers don't need to see. Everything reusable
(`deploy/backup.sh`, the self-hosting guide) stays public.

- **Server:** firewall allowing only 22, 80 and 443. SSH keys only. Unattended
  security upgrades. Docker's `json-file` log driver with rotation
  (`max-size`, `max-file`) so logs don't fill the disk. No Caddy access log,
  since it would record IPs.
- **DNS:**
  - `app.tripcord.dev` points at the server.
  - `tripcord.dev` points at GitHub Pages.
  - `status.tripcord.dev` points at the status provider.
  - SPF, DKIM and DMARC records are set for the OVH mailbox.
- **Deploy:** following `docs/self-hosting.md`, with
  `PUBLIC_URL=https://app.tripcord.dev`, `SIGNUP=invite-only`, SMTP configured, and
  Caddy in front.
- **Backups:** `deploy/backup.sh` nightly, plus one restore drill before the first
  invite, and again after each minor upgrade.
- **Monitoring:** an external uptime check on `https://app.tripcord.dev/health`, a
  heartbeat for the backup job, and a public status page at `status.tripcord.dev`.
  All of it runs on a hosted provider's free tier, not on the server.
- **Upgrades:** back up first, then `docker compose pull && up -d`, then check
  `/health`.
- **Dogfooding:** the author's own app reports to the hosted instance first.

## Testing

**Server.** Integration tests use testcontainers Postgres, following the existing
pattern.
- Signup invites:
  - Signup with one creates a personal org and consumes the invite.
  - It can't be reused.
  - An existing user accepting it gets `409`.
  - The CLI creates, lists and revokes them.
- Email: config validation (pair rule). The mailer is an injected interface, so
  tests use an in-memory fake and assert what would be sent.
- Password reset:
  - Unknown and known emails both return `204`, and only a known one sends mail.
  - The 2-minute per-user cooldown holds.
  - Expired, used and unknown tokens return `400`.
  - Confirming changes the password and ends every session.
  - Cleanup deletes old rows.
- Deletion:
  - Deleting a project removes its timelines and keys, and ingest with a deleted
    key returns `401`.
  - Deleting an org removes everything under it and leaves members' accounts.
  - Account deletion: wrong password gives `403`. Being the only owner of an org
    with other members gives `409` with the list. An org where the user is the
    only member is deleted with the account. Invite references become NULL.
  - Members get `403` on project and org deletion.
  - `isolation.test.ts` gains cases for the new routes across orgs.
- Export: NDJSON with one valid JSON object per line, all timelines across more
  than one page, a member of another org gets `404`, and the headers are correct.
- Migrations: the existing migration tests cover the new ones, starting from a
  database at the 0.1.x schema.

**Dashboard.** Tests for the reset pages, the three danger zones (the button stays
disabled until the confirmation is typed, and the account-deletion `409` list),
the signup-invite variant of the invite page, and the Settings tab.

**Site.** Its build runs in CI. A test checks that every internal link resolves
to a built page.

**Manual.** After deploying 0.2.0 to `app.tripcord.dev`:
- Create a signup invite with `--email`, sign up through the link.
- Reset the password by email.
- Export a project, then delete it.
- Run one restore drill.

## Explicitly out of scope

- Billing, plans, quotas and usage limits per org.
- Email verification, and running `SIGNUP=open` in public.
- A request-access form or waitlist. For now it's a mailto link.
- A formal DPA, terms of service beyond the commitments page, and cookie banners
  (there are no cookies to consent to).
- High availability, a second server, or moving the rate limiter to a shared store.
- Export for anything other than timelines, and importing data.
- HTML email and email templates.
- Analytics on the landing site.

## Open questions

- **The B2 bucket's region.** A Backblaze account's region is fixed when the
  account is created. If it's EU Central, the data stays in the EU. If it's a US
  region, the backups are still encrypted before they leave the server, but the
  privacy page must say they're stored in the US.
- **The contact address**, e.g. `hello@tripcord.dev`, on the OVH mailbox.
- **The remaining numbers in the commitments**: 14-day backups, 30 days' notice
  before paid plans, 6-month API overlap. Shutdown notice is settled at 60 days.
