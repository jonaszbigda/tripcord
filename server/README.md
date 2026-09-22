# @repro/server

The ingest API for `repro`. It receives the timelines that `@repro/js` (the browser
client) sends when something goes wrong, validates them, and stores them in Postgres
behind a per-project API key. It's a small self-host service, not a hosted SaaS —
you run it yourself.

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

## Creating projects and API keys

Projects and their API keys are managed with the admin CLI that ships in the
server image. Keys are stored hashed, so a key is printed **once**, when it's
created — copy it then.

With `docker compose`:

```bash
docker compose exec server node server/dist/cli.js project create "your-project-name"
# Created project "your-project-name" (<project-id>)
# rpk_...
# Store this API key now. It will not be shown again.
```

Or locally, against a Postgres you're already running:

```bash
DATABASE_URL=postgres://repro:repro@localhost:5432/repro \
  npm run admin -w server -- project create "your-project-name"
```

Use the printed `rpk_...` key as the `apiKey` passed to `init()` in `@repro/js`; it's
sent as the `X-Repro-Key` header.

All commands:

| Command                        | What it does                                                   |
| ------------------------------ | -------------------------------------------------------------- |
| `project create <name>`        | Create a project and its first API key.                        |
| `project list`                 | List projects with their number of active keys.                |
| `key create <projectId>`       | Mint an additional key for a project.                          |
| `key list <projectId>`         | List a project's keys (prefix, created, revoked).              |
| `key revoke <keyId>`           | Revoke a key. Ingest rejects it immediately.                   |

To rotate a key without dropping events: `key create`, deploy the new key to your
app, then `key revoke` the old one.

The CLI applies any pending database migrations before running a command, so it
works on a fresh database before the server has started.

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

## API

`POST /v1/timeline` — accepts a timeline payload (see `@repro/js`'s `TimelinePayload`
type), authenticated via the `X-Repro-Key` header. Returns `201 { id }` on success.

`GET /health` — liveness check, always `200 { status: "ok" }`.

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
