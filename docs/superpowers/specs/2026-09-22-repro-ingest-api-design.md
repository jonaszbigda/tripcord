# repro — ingest API design

Status: approved (ingest API only)
Date: 2026-09-22
Scope: the backend ingest API (`server/`) only — receiving, validating, and storing
timelines sent by `@repro/js`. Dashboard, API key issuance UI/flow, self-host packaging
polish, and hosted SaaS concerns are each their own future sub-project.

## Problem & concept

`@repro/js` (the client library, already built) sends a `TimelinePayload` via
`fetch(endpoint, { method: "POST", keepalive: true, headers: { "X-Repro-Key": apiKey },
body: JSON.stringify(payload) })` whenever an error occurs or a developer manually
flags one. Today `endpoint` points at nothing — there is no server. This spec covers
building that server: a minimal, self-hostable ingest API that accepts exactly the
payload shape the client already sends, validates the API key, and stores it in
Postgres, with a retention policy so storage doesn't grow unbounded.

No dashboard, no read-side beyond what's needed for testing this in isolation — this is
the write path only. A dashboard is a separate future spec once there's real data to
look at.

## Repo & package structure

The repo becomes an npm workspaces monorepo:

```
repro/
  packages/
    js/                  # existing client library — moved from repo root src/
      src/
      package.json        # @repro/js (unchanged otherwise)
  server/                 # new: ingest API
    src/
    drizzle/               # schema + generated migrations
    package.json            # @repro/server (private, not published)
    Dockerfile
  docker-compose.yml         # server + postgres — local dev AND self-host reference
  package.json                # root: "workspaces": ["packages/*", "server"]
```

- The client library's `src/`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`,
  and `eslint.config.js` move from the repo root into `packages/js/` — a real
  restructuring of already-shipped/pushed code, not just new files added alongside it.
  This should land as its own first commit/step, before any server code exists, so the
  "add a server" work starts from a clean, already-verified-working layout.
- The server imports the client's payload types directly —
  `import type { TimelinePayload, TimelineEvent, TimelineReason, TimelineMeta } from
  "@repro/js"` — via the workspace link. No type duplication between client and server;
  a client-side type change that would break the server surfaces as a compile error
  immediately rather than silent drift.
- Root-level `tsconfig.json`/`eslint.config.js` become shared/extended base configs
  rather than duplicated per package.

## Data model (Postgres, via Drizzle)

```ts
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const timelines = pgTable("timelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull(),
  reasonType: text("reason_type").notNull(),   // "error" | "unhandledrejection" | "manual"
  reason: jsonb("reason").notNull(),            // full TimelineReason (message?, name?, data?)
  events: jsonb("events").notNull(),            // TimelineEvent[]
  meta: jsonb("meta").notNull(),                // TimelineMeta
  receivedAt: timestamp("received_at").notNull().defaultNow(),
}, (table) => ({
  projectReceivedIdx: index("timelines_project_received_idx").on(table.projectId, table.receivedAt),
  projectReasonTypeIdx: index("timelines_project_reason_type_idx").on(table.projectId, table.reasonType),
}));
```

> Superseded: `projects.api_key` was dropped; keys now live hashed in `api_keys` —
> see `2026-09-22-repro-api-keys-design.md`.

Design choices worth recording:

- **`reason`/`events`/`meta` are `jsonb`, not exploded into per-field scalar columns.**
  Each is a small structured object (or array) from `TimelinePayload`; storing them as
  jsonb avoids a hand-written mapping layer that could drift from the client's actual
  TypeScript type. Postgres `jsonb` still supports indexing into nested fields later
  (`GIN` index, or `reason->>'type'` queries) if a future dashboard needs it — that's an
  additive change, not a rewrite.
- **`reasonType` is pulled out as its own scalar `text` column**, duplicating what's
  also inside the `reason` jsonb, because `reason.type` and `receivedAt` are expected to
  be the two most-used filters once a dashboard exists (e.g. "errors in the last 24h").
  Small deliberate redundancy, not drift risk — both are written from the same
  validated payload in one insert.
- **Plain `text`, not a Postgres enum, for `reasonType`.** Validity of the three allowed
  values is enforced once, at ingest, by the Fastify request schema. A future new reason
  type is then just a code change, not a schema migration.
- **Two separate indexes** (`(projectId, receivedAt)` and `(projectId, reasonType)`)
  rather than one compound index covering all three columns — simpler, doesn't commit to
  one specific future query shape before real dashboard usage patterns are known.
  Postgres can combine separate indexes via bitmap index scans reasonably well.
- **API keys** were originally stored as plain text in `projects.api_key`. They now
  live, hashed, in a separate `api_keys` table — see
  `2026-09-22-repro-api-keys-design.md`.

## API surface

### `POST /v1/timeline`

The endpoint the client's `endpoint` config points at. Request flow, in order:

1. **API key lookup** — `X-Repro-Key` header looked up against `projects.apiKey`
   (indexed equality). Missing or unknown key → `401 Unauthorized`, body never
   processed. This runs *before* body validation so an invalid key can't be used to
   probe payload validation behavior.

   > Superseded: the header is now hashed (SHA-256) and matched against an unrevoked
   > row in `api_keys`. A revoked key returns the same `401 { error: "Invalid API
   > key" }` as an unknown key — see `2026-09-22-repro-api-keys-design.md`.

2. **Body validation** — Fastify's built-in JSON Schema route validation, with a schema
   mirroring `TimelinePayload` exactly. A shape mismatch → `400 Bad Request` with
   Fastify's standard validation-error body — no hand-written validation code needed.
3. **Rate limit check** — keyed by `project.id` (post-lookup), via
   `@fastify/rate-limit`. Exceeded → `429 Too Many Requests`.
4. **Insert** — one `INSERT` into `timelines`, splitting the payload into its columns.
5. **Response** — `201 Created`, body `{ id: "<timeline uuid>" }`.

Worth stating explicitly: the client library's transport is fire-and-forget — it never
reads the response body or checks the status code (`fetch(...).catch(...)`, no
`.then()`). None of this response contract is consumed by the current client; it exists
for testability, debugging, and any future non-fire-and-forget caller.

**Payload size limit:** `bodyLimit` set to 256KB — headroom over the client's own
~64KB practical `keepalive` ceiling (per the client library's design doc), small enough
to bound abuse from a sender that isn't the real client.

> Extended by `2026-09-23-repro-dashboard-timelines-design.md`: the body accepts an
> optional `tags` array, stored in `timelines.tags` (`text[]`, GIN-indexed).

### `GET /health`

Trivial liveness check (`200 { status: "ok" }`, no DB query) for container
orchestration / self-host health checks.

## Retention & cleanup

A `RETENTION_DAYS` env var (default `30`) controls how long timelines are kept.
Cleanup runs as an **in-process scheduled task**: the Fastify server runs a periodic
timer (once every 24h) executing `DELETE FROM timelines WHERE received_at < now() -
RETENTION_DAYS days`.

This was chosen over two alternatives:
- **External cron / k8s CronJob** — cleaner separation, no duplicate-run concern, but
  self-host users would need a second scheduled container just for cleanup, working
  against keeping self-host to one container.
- **Postgres-native (`pg_cron`)** — elegant, but requires the `pg_cron` extension
  enabled, not available on every Postgres provider/self-hosted instance by default.

If the server ever runs as multiple instances (future SaaS horizontal scaling), each
instance running its own cleanup redundantly is harmless (the `DELETE WHERE` is
idempotent) rather than a correctness problem.

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string |
| `PORT` | `3000` | Server listen port |
| `RETENTION_DAYS` | `30` | Cleanup TTL |
| `RATE_LIMIT_MAX` | `100` | Requests per window per project |
| `RATE_LIMIT_WINDOW` | `1 minute` | Rate limit window |
| `BODY_LIMIT_BYTES` | `262144` (256KB) | Max request body size |
| `LOG_LEVEL` | `info` | Fastify's built-in Pino logger level |

Error responses use a consistent `{ error: "message" }` JSON shape across
400/401/429/500. Internal error details (stack traces) are logged server-side via
Fastify's built-in Pino logger but never included in the response body.

## Tooling

- **Fastify** + `@fastify/rate-limit` — the only extra Fastify plugin needed; JSON
  Schema validation is built in.
- **Drizzle ORM** + `drizzle-kit` for schema-as-code and migrations. Chosen over Prisma
  (heavier — bundles a separate Rust query-engine binary, more self-host/Docker
  friction historically) and raw `pg` queries (more boilerplate, manual type mapping).
  TypeScript-native, lightweight query builder, matches the project's existing
  minimal-dependency ethos.
- **Vitest** (already the project's test runner) for unit tests (validation/route
  logic) and integration tests via **testcontainers** — tests spin up a throwaway
  Postgres Docker container automatically for the test run and tear it down after, so
  no manual test-DB setup on any dev machine or CI runner with Docker available.
- **TypeScript**, sharing base `tsconfig.json`/`eslint.config.js` with `packages/js/`
  via the new npm-workspaces root.

## Deployment

`server/Dockerfile` — multi-stage build (install deps → `tsc` build → slim runtime
image on `node:alpine`), running the compiled server. A root-level `docker-compose.yml`
combines the server + a Postgres container, serving two purposes: the local dev
environment (`docker-compose up` gives a working ingest API + DB with zero manual
setup) and the reference self-host deployment — directly serving the original
"self-host via Docker" goal from the client library's own design brainstorm.

## Explicitly out of scope (future sub-projects)

- Dashboard / any read-side UI.
- API key issuance and hashing at rest — done in `2026-09-22-repro-api-keys-design.md`
  (operator CLI; dashboard self-serve is part of the dashboard sub-project).
- Self-host packaging polish beyond the docker-compose reference setup (install guide,
  versioned images, etc.).
- Hosted SaaS-specific concerns (multi-region, backups, managed Postgres setup docs).
