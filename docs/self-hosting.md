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
# {"status":"ok","version":"0.1.0"}
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

## Configuration

Every environment variable is documented in
[`server/README.md` → Environment variables](../server/README.md#environment-variables).
To set one that `docker-compose.yml` doesn't list, add it to the `server` service's
`environment`.

## Upgrading

`TRIPCORD_VERSION` pins a minor version (`0.1`), so pulling picks up patch releases
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

## Connecting your app

In the dashboard, create a project and copy its API key. Then, in your app:

```bash
npm i @tripcord/js
```

```ts
import { init } from "@tripcord/js";

init({
  endpoint: "https://tripcord.example.com/v1/timeline", // PUBLIC_URL + /v1/timeline
  apiKey: "rpk_…",
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
