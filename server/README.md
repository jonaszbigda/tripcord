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

## Getting an API key

There is no key-issuance endpoint or CLI yet — provisioning a project and its API
key is a direct database insert. Once Postgres is up (e.g. via `docker compose`
above), run:

```bash
docker compose exec postgres psql -U repro -d repro -c \
  "INSERT INTO projects (name, api_key) VALUES ('your-project-name', 'your-api-key');"
```

Use `your-api-key` as the `apiKey` passed to `init()` in `@repro/js`, and send it
as the `X-Repro-Key` header on requests to this server.

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
