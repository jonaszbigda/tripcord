# Self-hosting Tripcord

Tripcord runs as one server container, which serves both the ingest API and the dashboard, plus
Postgres. This guide runs a released image with Docker Compose. To run it from
source instead, see [`server/README.md`](../server/README.md).

## Requirements

- A Linux host (amd64 or arm64) with Docker and the Compose plugin (v2).
- A domain name pointing at the host, for HTTPS.

## Running

```bash
mkdir tripcord && cd tripcord
curl -fsSLO https://raw.githubusercontent.com/jonaszbigda/tripcord/main/deploy/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/jonaszbigda/tripcord/main/deploy/.env.example
```

Edit `.env`:

- `POSTGRES_PASSWORD`: generate one with `openssl rand -hex 32`. Hex keeps it safe
  inside the database URL.
- `PUBLIC_URL`: the URL people will open the dashboard at, e.g.
  `https://tripcord.example.com`.

Then start it and check it's alive:

```bash
docker compose up -d
curl -s localhost:3000/health
# {"status":"ok","version":"0.3.0"}
```

The server listens on `127.0.0.1:3000` only. Set up [HTTPS](#https) to reach it
from outside.

## First account

Open `PUBLIC_URL`. On a fresh instance, signup is open to exactly one person, and
that account becomes the first org owner. Do this right after starting, before you
share the URL.

After that, `SIGNUP` decides who can join:

- `invite-only` (the default): people join through invite links, which org owners
  create on the **Members** page.
- `open`: anyone who can reach the instance can sign up, and each new user gets
  their own org.

To let someone new in with their own org on an `invite-only` instance, create a
signup invite with the [admin CLI](#recovery-the-admin-cli). It prints a link once,
valid for 7 days. With [email](#email-optional) set up, `--email` sends it too:

```bash
docker compose exec server node server/dist/cli.js invite create --email someone@example.com
```

## HTTPS

Put a reverse proxy in front of the server. With [Caddy](https://caddyserver.com),
which gets certificates automatically, the whole config is:

```caddyfile
tripcord.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Behind a proxy, keep `TRUST_PROXY=true` (the `.env.example` default) so the login
and invalid-key rate limits see client IPs rather than the proxy's. Set it to
`false` if the server is ever reachable without the proxy, since clients could
then spoof their IP.

`PUBLIC_URL` must be the `https://` URL. It's used for the same-origin check on the
dashboard API, invite links and the GitHub callback, and an `https` URL makes the
session cookie `Secure`.

## GitHub login (optional)

1. Create a GitHub OAuth App (GitHub → Settings → Developer settings → OAuth Apps).
   Set **Authorization callback URL** to `<PUBLIC_URL>/api/auth/github/callback`.
2. Put its client id and secret in `.env` as `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`, then run `docker compose up -d`.

Users can then sign in with GitHub, or connect GitHub to an existing account in
their settings.

## Email (optional)

With SMTP set up, users can reset a forgotten password from the login page, and
`invite create --email` sends signup invites. Without it, both are hidden, and
`user reset-password` in the admin CLI is the fallback.

With `SIGNUP=open`, SMTP also turns on email verification: people who sign up with a
password must open a link sent to their address before they can use Tripcord.
Accounts nobody verifies are deleted after 7 days. GitHub sign-ups are already
verified by GitHub. Open signup without SMTP still works, without verification or
password reset, and the server logs a warning at startup.

Set both variables in `.env`, then run `docker compose up -d`:

```bash
SMTP_URL=smtps://user:password@smtp.example.com:465
EMAIL_FROM=Tripcord <no-reply@example.com>
```

URL-encode special characters in the password (`@` becomes `%40`, and so on). For
mail to arrive rather than land in spam, the sending domain needs SPF, DKIM and
DMARC records; your mail provider's docs list them.

## Configuration

Every environment variable is documented in
[`server/README.md` → Environment variables](../server/README.md#environment-variables).
To set one that `docker-compose.yml` doesn't list, add it to the `server` service's
`environment`.

## Capacity: rate limits

The server accepts up to `RATE_LIMIT_MAX` timelines per project per minute (default
100) and rejects the rest with `429`. The client doesn't retry, so those timelines
are lost.

That's plenty for errors. If you `capture()` moments that happen often, such as
every signup or checkout on a busy app, estimate your peak per minute and raise
`RATE_LIMIT_MAX` in `.env`, then `docker compose up -d`. `RATE_LIMIT_WINDOW` changes
the window. Both are described in
[`server/README.md` → Environment variables](../server/README.md#environment-variables).

## Upgrading

`TRIPCORD_VERSION` pins a minor version (`0.3`), so pulling picks up patch releases
and nothing more:

```bash
docker compose pull && docker compose up -d
curl -s localhost:3000/health   # check "version"
```

Database migrations run when the server starts, behind a Postgres advisory lock, so
they're applied exactly once. To move to a new minor version, [back up](#backups)
first, then change `TRIPCORD_VERSION` and pull.

## Backups

```bash
# Back up
docker compose exec -T postgres pg_dump -U tripcord -Fc tripcord > tripcord-$(date +%F).dump

# Restore
docker compose exec -T postgres pg_restore -U tripcord -d tripcord --clean --if-exists < tripcord-2026-09-24.dump
```

The retention job already deletes timelines older than `RETENTION_DAYS` (default
30), so a backup holds at most that window of timelines, plus accounts, orgs,
projects and keys.

### Off-site backups

A dump on the same disk doesn't survive losing the machine. `deploy/backup.sh` dumps
the database and sends it, encrypted, to any [restic](https://restic.net)
repository: S3-compatible storage such as Backblaze B2, an SFTP server, and others.
It keeps 14 daily backups by default.

1. Install restic on the host, and put the script and its settings next to
   `docker-compose.yml`:

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/jonaszbigda/tripcord/main/deploy/backup.sh
   curl -fsSL -o backup.env https://raw.githubusercontent.com/jonaszbigda/tripcord/main/deploy/backup.env.example
   chmod +x backup.sh && chmod 600 backup.env
   ```

2. Fill in `backup.env`. Keep a copy of `RESTIC_PASSWORD` somewhere other than
   this server: without it, the backups can't be restored.
3. Create the repository once, then try a backup:

   ```bash
   set -a && . ./backup.env && set +a
   restic init
   ./backup.sh && restic snapshots
   ```

4. Run it nightly from cron:

   ```cron
   15 3 * * * /path/to/tripcord/backup.sh >> /var/log/tripcord-backup.log 2>&1
   ```

The script exits non-zero on any failure. Set `BACKUP_HEARTBEAT_URL` in
`backup.env` to a heartbeat monitor, so a backup that stops running doesn't go
unnoticed.

### Restore drill

A backup you haven't restored is a guess. Restore the latest one into a throwaway
Postgres and compare it with the live database:

```bash
set -a && . ./backup.env && set +a
restic restore latest --tag tripcord --target /tmp/tripcord-restore
docker run -d --name tripcord-drill -e POSTGRES_PASSWORD=drill postgres:16-alpine
sleep 5
docker exec tripcord-drill createdb -U postgres tripcord
docker exec -i tripcord-drill pg_restore -U postgres -d tripcord --no-owner < /tmp/tripcord-restore/tripcord.dump
docker exec tripcord-drill psql -U postgres -d tripcord -tc "select count(*) from users"
docker compose exec -T postgres psql -U tripcord -d tripcord -tc "select count(*) from users"
docker rm -f tripcord-drill && rm -rf /tmp/tripcord-restore
```

The counts should match, give or take what changed since the backup. Do this once
after setting up backups, and again after upgrading to a new minor version.

## Logs

The server writes no client IP addresses and no invite or reset tokens to its logs.
`deploy/docker-compose.yml` rotates them at 50 MB per container. If you turn on
access logs in your reverse proxy, those will contain IP addresses.

## Connecting your app

In the dashboard, create a project and copy its API key. Then, in your app:

```bash
npm i @tripcord/js
```

```ts
import { init } from "@tripcord/js";

init({
  endpoint: "https://tripcord.example.com/v1/timeline", // PUBLIC_URL + /v1/timeline
  apiKey: "tpk_…",
});
```

See the [`@tripcord/js` README](../packages/js/README.md) for tracking events,
tags and the React error boundary.

## Recovery: the admin CLI

The image includes an admin CLI for bootstrap and recovery, e.g. resetting a
password when nobody can log in:

```bash
docker compose exec server node server/dist/cli.js --help
docker compose exec server node server/dist/cli.js user reset-password you@example.com
```

See [`server/README.md` → The admin CLI](../server/README.md#the-admin-cli) for
every command.
