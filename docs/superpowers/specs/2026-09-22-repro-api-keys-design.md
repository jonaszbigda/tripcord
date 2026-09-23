# repro — project & API key issuance design

Status: approved
Date: 2026-09-22
Scope: creating projects and API keys for the ingest server (`server/`), and hashing
keys at rest. Delivered as an operator CLI on top of a shared service layer. The
dashboard (including tenant self-serve project/key management) is the next,
separate sub-project and reuses the service layer defined here.

## Problem & concept

The ingest API (see `2026-09-22-repro-ingest-api-design.md`) authenticates every
`POST /v1/timeline` by looking up the `X-Repro-Key` header against
`projects.api_key`, stored as plain text. There is no way to create a project or key
other than a hand-written SQL `INSERT`, and a single key per project means rotating
a key breaks ingest until the new key is deployed.

This spec adds:

- An `api_keys` table: many keys per project, stored as SHA-256 hashes, revocable.
- A service layer (`createProject`, `createApiKey`, `listProjects`, `listApiKeys`,
  `revokeApiKey`, `findProjectByApiKey`) that both the CLI and the future dashboard
  call.
- An operator CLI (`server/dist/cli.js`) wrapping that service layer.

### What hashing does and doesn't buy

`@repro/js` sends the key from the browser, so a key is a *publishable* credential
(like a Sentry DSN): anyone with devtools open on an instrumented site can read it.
Hashing at rest does not protect a key that is already public. It does mean a
database dump or backup leak doesn't expose every project's key, and it makes "the
key is only shown once, at creation" true by construction. It is cheap to do now and
awkward to retrofit later.

### Relationship to the dashboard

Tenant self-serve (a logged-in user creating projects and minting keys in the
dashboard) is intended, but requires accounts, login and an ownership model, all of
which belong to the dashboard spec. This spec does not add an owner/org column; the
dashboard spec decides the tenancy model and adds the FK in its own migration. The
dashboard's routes call the same service functions as the CLI, so key generation and
hashing exist in exactly one place.

## Data model (Postgres, via Drizzle)

### `api_keys` (new)

| column       | type                        | notes                                                                 |
| ------------ | --------------------------- | --------------------------------------------------------------------- |
| `id`         | uuid, PK                    | `defaultRandom()`                                                     |
| `project_id` | uuid, FK → `projects.id`    | not null                                                              |
| `key_hash`   | text                        | not null, **unique**. Lowercase hex SHA-256 of the full key.          |
| `prefix`     | text                        | not null. First 12 characters of the key (e.g. `rpk_3f9aK2xQ`), for display. |
| `created_at` | timestamp                   | not null, `defaultNow()`                                              |
| `revoked_at` | timestamp                   | nullable; `NULL` = active                                             |

Plus an index on `project_id` (`api_keys_project_idx`) for listing a project's keys.
The unique constraint on `key_hash` provides the ingest lookup index.

- Revocation is a soft delete (`revoked_at` set), keeping a record of which keys
  existed. Revoked keys fail auth immediately.
- No `last_used_at`: it would add a write to every ingest request. The dashboard may
  add it (likely debounced) if it wants to show usage.

### `projects` (changed)

`api_key` is dropped. `projects` keeps `id`, `name`, `created_at`. Project names are
not unique — projects are identified by id.

### Migration

One drizzle-kit-generated migration: create `api_keys` (with its unique constraint
and index), then drop `projects.api_key`. **Clean break:** there are no real
deployments with keys to preserve, so existing plaintext keys are not carried over;
operators mint new keys with the CLI. No `pgcrypto` dependency.

## Key format

`rpk_` + base64url encoding of 32 bytes from `crypto.randomBytes` (43 characters),
47 characters total.

- The `rpk_` prefix makes leaked keys greppable and recognizable by secret scanners.
- Keys are high-entropy random values, so a fast hash (SHA-256) is correct; slow
  password hashes (bcrypt/argon2) would add latency to every ingest request and
  force a prefix-lookup-then-compare scheme for no security gain.
- The plaintext key is returned exactly once, at creation. Afterwards only `prefix`
  is shown.

## Service layer

### `server/src/keys.ts` (new) — pure primitives, no DB

- `generateApiKey(): { key: string; prefix: string; hash: string }`
- `hashApiKey(key: string): string` — SHA-256, lowercase hex. Used at creation and
  by ingest auth.

### `server/src/db/projects.ts` (expanded) — shared by CLI and future dashboard

- `createProject(db, name) → { project, key }` — inserts the project and its first
  key in one transaction; returns the plaintext key.
- `createApiKey(db, projectId) → { apiKey, key } | undefined` — mints an additional
  key (rotation). Returns `undefined` if the project doesn't exist; callers map that
  to their own error (CLI message, dashboard 404).
- `listProjects(db)` — projects with a count of active (unrevoked) keys.
- `listApiKeys(db, projectId)` — `id`, `prefix`, `createdAt`, `revokedAt` per key.
  Never returns `key_hash`.
- `revokeApiKey(db, keyId) → { apiKey, alreadyRevoked } | undefined` — sets
  `revoked_at` if not already set. Idempotent: revoking an already-revoked key
  returns it with `alreadyRevoked: true` and its original `revokedAt` untouched.
  Returns `undefined` for an unknown id.
- `findProjectByApiKey(db, key)` — same name and signature as today. Now hashes the
  key and joins `api_keys` → `projects` on `key_hash = $1 AND revoked_at IS NULL`.
  Still a single indexed query.

A `key_hash` unique-constraint collision (256 bits of entropy) is not retried; the
insert error propagates.

## Ingest auth (behavior unchanged)

`server/src/routes/timeline.ts` is unchanged: the `preValidation` hook still calls
`findProjectByApiKey`, returns `401 { error: "Missing X-Repro-Key header" }` or
`401 { error: "Invalid API key" }`, and runs before body validation.

- A revoked key returns the same `401 Invalid API key` as an unknown key, so the
  response doesn't reveal that a key once existed.
- Rate limiting stays keyed per project, not per key: a project with several active
  keys shares one budget.

## CLI

Entrypoint `server/src/cli.ts`, built to `server/dist/cli.js`. Arguments are parsed
with `node:util` `parseArgs` (no new dependency). Reads `DATABASE_URL` like
`index.ts`.

```
repro-admin project create <name>      prints project id + key (once)
repro-admin project list               id, name, created, active key count
repro-admin key create <projectId>     prints new key (once)
repro-admin key list <projectId>       id, prefix, created, revoked
repro-admin key revoke <keyId>
```

(`repro-admin` is the name used in usage text; there is no `bin` entry because the
server package is private and unpublished.)

Invocation:

- Docker: `docker compose exec server node server/dist/cli.js project create "Acme"`
- Local: `npm run admin -w @repro/server -- project create Acme` (an `admin` script
  that builds first, then runs `node dist/cli.js`).

Behavior:

- Output is plain text tables. On key creation the key is printed on its own line,
  followed by a warning that it will not be shown again. No `--json` for now.
- **The CLI runs migrations before executing a command.** The migrate block in
  `index.ts` is extracted into `runMigrations(databaseUrl)` in
  `server/src/db/migrate.ts`, called by both `index.ts` and `cli.ts`. Drizzle's
  migrator skips already-applied migrations, so running it from both is safe, and
  `project create` works against a fresh database before the server has ever booted.
- The CLI closes the DB pool (`db.$client.end()`) in a `finally` so the process
  exits promptly.
- `cli.ts` is a thin entrypoint (env check, migrations, pool lifecycle, process
  exit code). Command dispatch lives in `server/src/admin.ts` as
  `runCli(argv, db, out) → Promise<number>` (exit code), where `out` is an output
  sink with `stdout`/`stderr` writers, so tests drive it without spawning a process.
  Keeping it in a separate module means importing it in tests never runs `main()`.

### CLI errors

Each error prints one line to stderr and exits with the code shown. Only the first
row (unknown command, missing or extra argument, unknown flag) also prints usage
text. The already-revoked case is not an error: it prints to stdout and exits 0.

| Case                                               | Exit | Message                                     |
| -------------------------------------------------- | ---- | ------------------------------------------- |
| Unknown command / missing or extra argument / unknown flag | 2 | the error, then usage text          |
| `DATABASE_URL` unset                               | 1    | `DATABASE_URL is required`                  |
| Malformed project/key id (not a UUID)              | 2    | `Invalid id: <x>`                           |
| `key create` for a nonexistent project             | 1    | `Project not found: <id>`                   |
| `key revoke` for an unknown key                    | 1    | `Key not found: <id>`                       |
| Revoking an already-revoked key                    | 0    | `Key <prefix> already revoked at <ts>`      |
| Empty or whitespace-only project name              | 2    | `Project name is required`                  |

UUIDs are validated before querying, so Postgres never raises a uuid cast error.
Unexpected errors print a stack trace and exit 1. `DATABASE_URL` is checked in
`cli.ts` before a DB connection is created; all other cases are handled in `runCli`.

## Testing

Existing setup: Vitest, testcontainers Postgres via `globalSetup`, serial test files,
each test cleans up its own rows.

- `server/test/db.ts` gains `createTestProject(db, name?) → { project, key }`
  (a thin wrapper over `createProject`). Tests stop inserting `projects` rows with
  `apiKey`.
- `server/src/keys.test.ts` (unit, no DB): `rpk_` prefix and total length 47;
  `prefix` is the first 12 characters; hash is deterministic, 64-char lowercase hex,
  and differs across keys; two generated keys differ.
- `server/src/db/projects.test.ts` (rewritten): `createProject`'s key resolves via
  `findProjectByApiKey`; unknown and revoked keys resolve to `undefined`; multiple
  active keys on one project all resolve to it; `createApiKey` on a missing project
  returns `undefined`; revoke is idempotent and preserves the original `revokedAt`;
  `listApiKeys` never exposes hashes; the stored row does not contain the plaintext
  key anywhere (read directly from `api_keys`).
- `server/src/admin.test.ts`: drives `runCli` with a captured sink. Each command's
  success path; each CLI error row above (except `DATABASE_URL`, which lives in
  `cli.ts`) with its exit code; key printed on creation and never by `list`.
- Existing `timeline.test.ts`, `retention.test.ts`, `schema.test.ts` switch to
  `createTestProject` / the new schema. New ingest test: after revoking a key, the
  next `POST /v1/timeline` with it returns `401 { error: "Invalid API key" }`.

## Docs

- `server/README.md`: the "Getting an API key" section (currently a raw SQL
  `INSERT`) is replaced with CLI usage for both Docker and local runs.
- `2026-09-22-repro-ingest-api-design.md`: the out-of-scope entries for key issuance
  and hashing at rest point to this spec.

## Explicitly out of scope

- Tenancy / project ownership, user accounts, login — see 2026-09-23-repro-dashboard-accounts-design.md.
- `last_used_at` tracking — dashboard spec, if wanted.
- Per-key rate limits, key expiry dates.
- `--json` CLI output.
- Deleting or renaming projects.
- An HTTP admin API.
