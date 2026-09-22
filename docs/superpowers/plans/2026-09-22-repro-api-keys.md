# repro Project & API Key Issuance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plaintext `projects.api_key` column with a hashed, multi-key, revocable `api_keys` table, a shared service layer for creating/listing/revoking projects and keys, and an operator CLI on top of it.

**Architecture:** Pure key primitives (`server/src/keys.ts`: generate + SHA-256 hash) feed a DB service layer (`server/src/db/projects.ts`) that both the CLI and the future dashboard call. Ingest auth keeps calling `findProjectByApiKey` unchanged; only its internals change (hash the incoming key, join `api_keys` → `projects`, skip revoked). The CLI is split into a testable dispatcher (`server/src/admin.ts`, `runCli(argv, db, out)`) and a thin process entrypoint (`server/src/cli.ts`), which shares a new `runMigrations()` helper with the server entrypoint.

**Tech Stack:** TypeScript, Drizzle ORM + drizzle-kit, `pg`, `node:crypto`, `node:util` `parseArgs`, Vitest + `@testcontainers/postgresql`, Docker.

**Spec:** `docs/superpowers/specs/2026-09-22-repro-api-keys-design.md`

## Global Constraints

- Keys are `rpk_` + base64url of 32 bytes from `crypto.randomBytes` — 47 characters total.
- Stored as lowercase hex SHA-256 (`key_hash`, unique). Never bcrypt/argon2. The plaintext key is never stored and is returned only once, at creation.
- `prefix` = the first 12 characters of the key; the only part of a key ever displayed after creation.
- Revocation is soft (`revoked_at` set), idempotent, and preserves the original `revoked_at`.
- A revoked key and an unknown key both produce ingest `401 { error: "Invalid API key" }` — identical responses.
- `findProjectByApiKey(db, key)` keeps its exact name and signature; `server/src/routes/timeline.ts` is not modified.
- Rate limiting stays keyed per project, not per key.
- Clean-break migration: drop `projects.api_key`, do not carry existing keys over, no `pgcrypto`.
- No owner/org/tenant column, no `last_used_at`, no `--json`, no project delete/rename, no HTTP admin API.
- CLI arguments are parsed with `node:util` `parseArgs` — no new runtime dependency.
- CLI exit codes: `0` success (including already-revoked), `1` not-found / missing `DATABASE_URL` / unexpected error, `2` usage/argument errors.
- Only command-shape errors (unknown command, missing/extra argument, unknown flag) print usage text.
- Project names are not unique; empty/whitespace-only names are rejected by the CLI.
- Integration tests use the existing testcontainers Postgres (`inject("databaseUrl")` via `server/test/db.ts`); files run serially; every test cleans up its own rows.
- Error responses and messages match the spec's CLI error table verbatim.

## Prerequisites

Dependencies are not installed in a fresh checkout. From the repo root, once:

```bash
npm install
```

Docker must be running: every server test file shares a testcontainers Postgres started in `server/test/globalSetup.ts`.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `server/src/keys.ts` | create | Pure key primitives: `generateApiKey()`, `hashApiKey()`. No DB. |
| `server/src/keys.test.ts` | create | Unit tests for the primitives. |
| `server/src/db/schema.ts` | modify | Drop `projects.apiKey`; add `apiKeys` table + `ApiKey` type. |
| `server/drizzle/0001_*.sql` + `server/drizzle/meta/*` | generate | drizzle-kit migration: create `api_keys`, drop `projects.api_key`. |
| `server/src/db/projects.ts` | modify | Service layer: `createProject`, `createApiKey`, `listProjects`, `listApiKeys`, `revokeApiKey`, `findProjectByApiKey`. |
| `server/src/db/projects.test.ts` | rewrite | Service-layer integration tests. |
| `server/test/db.ts` | modify | Add `resetDb(db)` and `createTestProject(db, name?)`. |
| `server/src/db/schema.test.ts`, `server/src/retention.test.ts`, `server/src/routes/timeline.test.ts` | modify | Use the new helpers; one new revoked-key ingest test. |
| `server/src/db/migrate.ts` | create | `runMigrations(databaseUrl)` — shared by server and CLI entrypoints. |
| `server/src/db/migrate.test.ts` | create | Proves the migrations path resolves and re-running is a no-op. |
| `server/src/index.ts` | modify | Call `runMigrations()` instead of the inline migrate block. |
| `server/src/admin.ts` | create | `runCli(argv, db, out)`: argument parsing, dispatch, output formatting. |
| `server/src/admin.test.ts` | create | CLI behavior tests via a captured output sink. |
| `server/src/cli.ts` | create | Process entrypoint: env check, migrations, pool lifecycle, exit code. |
| `server/package.json` | modify | Add `admin` script. |
| `server/README.md` | modify | Replace "Getting an API key" SQL instructions with CLI usage. |
| `docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md` | modify | Point the key-issuance/hashing out-of-scope entries at the new spec. |

---

### Task 1: Key primitives

**Files:**
- Create: `server/src/keys.ts`
- Test: `server/src/keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface GeneratedApiKey { key: string; prefix: string; hash: string }`
  - `export function generateApiKey(): GeneratedApiKey`
  - `export function hashApiKey(key: string): string`

- [x] **Step 1: Write the failing test**

Create `server/src/keys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "./keys";

describe("generateApiKey", () => {
  it("produces an rpk_-prefixed key of 43 base64url characters (47 total)", () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^rpk_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(47);
  });

  it("uses the first 12 characters of the key as the display prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toHaveLength(12);
    expect(prefix).toBe(key.slice(0, 12));
  });

  it("returns the SHA-256 hash of the key", () => {
    const { key, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(key));
  });

  it("generates a different key each call", () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first.key).not.toBe(second.key);
    expect(first.hash).not.toBe(second.hash);
  });
});

describe("hashApiKey", () => {
  it("returns lowercase hex SHA-256", () => {
    // Known SHA-256 test vector for "abc".
    expect(hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic and differs for different inputs", () => {
    expect(hashApiKey("rpk_same")).toBe(hashApiKey("rpk_same"));
    expect(hashApiKey("rpk_one")).not.toBe(hashApiKey("rpk_two"));
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run (from `server/`): `npx vitest run src/keys.test.ts`
Expected: FAIL — cannot resolve `./keys`.

- [x] **Step 3: Write the implementation**

Create `server/src/keys.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "rpk_";
const KEY_RANDOM_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** The plaintext key. Shown to the user once, never stored. */
  key: string;
  /** First 12 characters of `key`, stored for display. */
  prefix: string;
  /** SHA-256 of `key`, lowercase hex. The only form stored. */
  hash: string;
}

// Keys are 256-bit random values, so a fast hash is the right tool: there's no
// low-entropy secret for a slow password hash (bcrypt/argon2) to protect, and a
// fast hash keeps ingest auth to a single indexed equality lookup.
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const key = KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString("base64url");
  return { key, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), hash: hashApiKey(key) };
}
```

- [x] **Step 4: Run test to verify it passes**

Run (from `server/`): `npx vitest run src/keys.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Lint and commit**

Run: `npm run lint -w server`
Expected: no errors.

```bash
git add server/src/keys.ts server/src/keys.test.ts
git commit -m "feat(server): add API key generation and hashing primitives"
```

---

### Task 2: `api_keys` schema, migration, hashed ingest lookup

This task changes the schema, so every existing test that inserts `projects.apiKey` must be migrated in the same task to keep the suite green.

**Files:**
- Modify: `server/src/db/schema.ts`
- Generate: `server/drizzle/0001_<random_name>.sql`, `server/drizzle/meta/0001_snapshot.json`, `server/drizzle/meta/_journal.json`
- Modify: `server/src/db/projects.ts`
- Modify: `server/test/db.ts`
- Rewrite: `server/src/db/projects.test.ts`
- Modify: `server/src/db/schema.test.ts`, `server/src/retention.test.ts`, `server/src/routes/timeline.test.ts`

**Interfaces:**
- Consumes: `generateApiKey()`, `hashApiKey()` from Task 1 (`server/src/keys.ts`).
- Produces:
  - `schema.ts`: `projects` (`id`, `name`, `createdAt`), `apiKeys` (`id`, `projectId`, `keyHash`, `prefix`, `createdAt`, `revokedAt`), `type Project`, `type ApiKey`.
  - `projects.ts`: `export interface CreatedProject { project: Project; key: string }`, `export async function createProject(db: Database, name: string): Promise<CreatedProject>`, `export async function findProjectByApiKey(db: Database, key: string): Promise<Project | undefined>`.
  - `test/db.ts`: `export async function resetDb(db: Database): Promise<void>`, `export async function createTestProject(db: Database, name?: string): Promise<CreatedProject>`.

- [x] **Step 1: Update the schema**

Replace the `projects` table definition in `server/src/db/schema.ts` and add `apiKeys` after it. The full file becomes:

```ts
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    // SHA-256 of the full key, lowercase hex. The plaintext key is never stored.
    keyHash: text("key_hash").notNull().unique(),
    // First 12 characters of the key, so keys can be told apart in listings.
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // NULL = active. Revocation is a soft delete so there's a record of which keys existed.
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    projectIdx: index("api_keys_project_idx").on(table.projectId),
  })
);

export const timelines = pgTable(
  "timelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    sessionId: text("session_id").notNull(),
    reasonType: text("reason_type").notNull(),
    reason: jsonb("reason").notNull(),
    events: jsonb("events").notNull(),
    meta: jsonb("meta").notNull(),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => ({
    projectReceivedIdx: index("timelines_project_received_idx").on(table.projectId, table.receivedAt),
    projectReasonTypeIdx: index("timelines_project_reason_type_idx").on(table.projectId, table.reasonType),
  })
);

export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Timeline = typeof timelines.$inferSelect;
```

- [x] **Step 2: Generate the migration**

Run (from `server/`): `npx drizzle-kit generate`
Expected: a new `drizzle/0001_<random_name>.sql`, a new `drizzle/meta/0001_snapshot.json`, and an updated `drizzle/meta/_journal.json`. drizzle-kit does not need a live database for `generate` (the config's placeholder URL is fine). If it prompts interactively about the column change, the answer is: `api_key` is **dropped**, not renamed.

Open the generated SQL and confirm it contains all of the following (drizzle-kit's exact formatting may differ):
- `CREATE TABLE IF NOT EXISTS "api_keys"` with `id`, `project_id`, `key_hash`, `prefix`, `created_at`, `revoked_at`, and `CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")`
- the `api_keys_project_id_projects_id_fk` foreign key
- `CREATE INDEX IF NOT EXISTS "api_keys_project_idx" ON "api_keys" ... ("project_id")`
- `ALTER TABLE "projects" DROP COLUMN IF EXISTS "api_key"` (this also drops `projects_api_key_unique`)

Do not hand-edit the generated files.

- [x] **Step 3: Add test helpers**

Replace `server/test/db.ts` with:

```ts
import { inject } from "vitest";
import { createDb, type Database } from "../src/db/client";
import { apiKeys, projects, timelines } from "../src/db/schema";
import { createProject, type CreatedProject } from "../src/db/projects";

export function getTestDb(): Database {
  return createDb(inject("databaseUrl"));
}

// Deletes in foreign-key order: timelines and api_keys both reference projects.
export async function resetDb(db: Database): Promise<void> {
  await db.delete(timelines);
  await db.delete(apiKeys);
  await db.delete(projects);
}

export async function createTestProject(db: Database, name = "acme"): Promise<CreatedProject> {
  return createProject(db, name);
}
```

- [x] **Step 4: Write the failing service tests**

Replace `server/src/db/projects.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, getTestDb, resetDb } from "../../test/db";
import { hashApiKey } from "../keys";
import { apiKeys } from "./schema";
import { createProject, findProjectByApiKey } from "./projects";

describe("createProject", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates the project and returns a plaintext rpk_ key", async () => {
    const db = getTestDb();
    const { project, key } = await createProject(db, "widgets-inc");

    expect(project.name).toBe("widgets-inc");
    expect(key).toMatch(/^rpk_[A-Za-z0-9_-]{43}$/);
  });

  it("stores only the hash and display prefix, never the plaintext key", async () => {
    const db = getTestDb();
    const { project, key } = await createProject(db, "widgets-inc");

    const rows = await db.select().from(apiKeys).where(eq(apiKeys.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].keyHash).toBe(hashApiKey(key));
    expect(rows[0].prefix).toBe(key.slice(0, 12));
    expect(rows[0].revokedAt).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(key);
  });

  it("allows two projects with the same name", async () => {
    const db = getTestDb();
    const first = await createProject(db, "web");
    const second = await createProject(db, "web");
    expect(first.project.id).not.toBe(second.project.id);
  });
});

describe("findProjectByApiKey", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns the project for a valid key", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db, "widgets-inc");

    const found = await findProjectByApiKey(db, key);

    expect(found?.id).toBe(project.id);
    expect(found?.name).toBe("widgets-inc");
  });

  it("returns undefined for an unknown key", async () => {
    const db = getTestDb();
    await createTestProject(db);
    expect(await findProjectByApiKey(db, "rpk_no-such-key")).toBeUndefined();
  });

  it("returns undefined for a revoked key", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.keyHash, hashApiKey(key)));

    expect(await findProjectByApiKey(db, key)).toBeUndefined();
  });
});
```

- [x] **Step 5: Run the tests to verify they fail**

Run (from `server/`): `npx vitest run src/db/projects.test.ts`
Expected: FAIL — `createProject` is not exported from `./projects`, and `findProjectByApiKey` still queries the dropped `projects.api_key` column.

- [x] **Step 6: Implement `createProject` and the hashed lookup**

Replace `server/src/db/projects.ts` with:

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./client";
import { apiKeys, projects, type Project } from "./schema";
import { generateApiKey, hashApiKey } from "../keys";

export interface CreatedProject {
  project: Project;
  /** Plaintext key — returned once, never stored. */
  key: string;
}

export async function createProject(db: Database, name: string): Promise<CreatedProject> {
  return db.transaction(async (tx) => {
    const [project] = await tx.insert(projects).values({ name }).returning();
    const generated = generateApiKey();
    await tx.insert(apiKeys).values({
      projectId: project.id,
      keyHash: generated.hash,
      prefix: generated.prefix,
    });
    return { project, key: generated.key };
  });
}

// Revoked and unknown keys are indistinguishable here on purpose, so ingest
// returns the same 401 for both and never reveals that a key once existed.
export async function findProjectByApiKey(db: Database, key: string): Promise<Project | undefined> {
  const [found] = await db
    .select({ project: projects })
    .from(apiKeys)
    .innerJoin(projects, eq(apiKeys.projectId, projects.id))
    .where(and(eq(apiKeys.keyHash, hashApiKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1);
  return found?.project;
}
```

- [x] **Step 7: Run the service tests to verify they pass**

Run (from `server/`): `npx vitest run src/db/projects.test.ts`
Expected: PASS (6 tests).

- [x] **Step 8: Migrate the remaining tests off `projects.apiKey`**

`server/src/db/schema.test.ts` — replace the whole file with:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetDb } from "../../test/db";
import { apiKeys, projects } from "./schema";

describe("schema wiring", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("can insert a project with an api key row and read both back", async () => {
    const db = getTestDb();

    const [inserted] = await db.insert(projects).values({ name: "test project" }).returning();
    await db.insert(apiKeys).values({ projectId: inserted.id, keyHash: "hash-123", prefix: "rpk_prefix12" });

    const found = await db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.id, inserted.id),
    });
    const key = await db.query.apiKeys.findFirst({
      where: (k, { eq }) => eq(k.projectId, inserted.id),
    });

    expect(found?.name).toBe("test project");
    expect(key?.keyHash).toBe("hash-123");
    expect(key?.revokedAt).toBeNull();
  });
});
```

`server/src/retention.test.ts` — three edits:
1. Replace the imports block's first three lines with:
   ```ts
   import { describe, it, expect, beforeEach } from "vitest";
   import { createTestProject, getTestDb, resetDb } from "../test/db";
   import { timelines } from "./db/schema";
   ```
2. Replace the `beforeEach` body with `await resetDb(getTestDb());`
3. Replace
   ```ts
   const [project] = await db.insert(projects).values({ name: "acme", apiKey: "key-1" }).returning();
   ```
   with
   ```ts
   const { project } = await createTestProject(db);
   ```

`server/src/routes/timeline.test.ts` — replace the whole file with (existing tests unchanged in intent; seeding switched to `createTestProject`; one new revoked-key test at the end of the first `describe`):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, getTestDb, resetDb } from "../../test/db";
import { apiKeys, timelines } from "../db/schema";
import { hashApiKey } from "../keys";
import { buildApp } from "../app";

const validPayload = {
  sessionId: "session-1",
  reason: { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
  events: [{ timestamp: 1, type: "custom", name: "checkout.step" }],
  meta: { url: "https://example.com/checkout", userAgent: "test-agent", capturedAt: 1700000000000 },
};

describe("POST /v1/timeline", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns 401 when the X-Repro-Key header is missing", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({ method: "POST", url: "/v1/timeline", payload: validPayload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Missing X-Repro-Key header" });
  });

  it("returns 401 when the api key doesn't match any project", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "no-such-key" },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid API key" });
  });

  it("returns 400 for a malformed body, without inserting anything", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: { sessionId: "session-1" }, // missing reason/events/meta
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
  });

  it("returns 400 and inserts nothing for a payload with an unknown extra field, instead of silently stripping it", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: { ...validPayload, futureField: "should be rejected, not stripped" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
  });

  it("returns 401 for an unknown api key even with a malformed body, proving auth runs before validation", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "no-such-key" },
      payload: { totally: "wrong shape" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("stores a valid payload and returns 201 with an id", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeTypeOf("string");

    const [row] = await db.select().from(timelines);
    expect(row.projectId).toBe(project.id);
    expect(row.sessionId).toBe("session-1");
    expect(row.reasonType).toBe("manual");
    expect(row.reason).toEqual(validPayload.reason);
    expect(row.events).toEqual(validPayload.events);
    expect(row.meta).toEqual(validPayload.meta);
  });

  it("returns the same 401 for a revoked key as for an unknown key", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.keyHash, hashApiKey(key)));
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid API key" });
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
  });
});

describe("POST /v1/timeline rate limiting", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns 429 after exceeding the per-project limit", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 2, rateLimitWindow: "1 minute" });

    const first = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: validPayload,
    });
    const third = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: validPayload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: expect.any(String) });
  });
});
```

Before replacing `timeline.test.ts`, diff it against the version above: if the file on disk has any test not shown here, keep that test and only switch its seeding to `createTestProject` / `resetDb`.

Then confirm nothing still references the dropped column:

Run (from repo root): `grep -rn "apiKey:" server/src server/test`
Expected: no matches.

- [x] **Step 9: Run the full server suite, lint, and typecheck**

Run: `npm test -w server && npm run lint -w server && npm run typecheck -w server`
Expected: all pass. `server/src/routes/timeline.ts` must be unchanged (`git diff --quiet server/src/routes/timeline.ts` exits 0).

- [x] **Step 10: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/src/db/projects.ts server/src/db/projects.test.ts \
  server/test/db.ts server/src/db/schema.test.ts server/src/retention.test.ts server/src/routes/timeline.test.ts
git commit -m "feat(server): store API keys hashed in an api_keys table"
```

---

### Task 3: Key rotation and listing service functions

**Files:**
- Modify: `server/src/db/projects.ts`
- Test: `server/src/db/projects.test.ts`

**Interfaces:**
- Consumes: `createProject`, `findProjectByApiKey` (Task 2); `apiKeys`, `projects`, `ApiKey`, `Project` (Task 2 schema); `generateApiKey` (Task 1); `resetDb`, `createTestProject`, `getTestDb` (Task 2 `server/test/db.ts`).
- Produces (all exported from `server/src/db/projects.ts`):
  - `export type ApiKeySummary = Pick<ApiKey, "id" | "projectId" | "prefix" | "createdAt" | "revokedAt">`
  - `export interface CreatedApiKey { apiKey: ApiKeySummary; key: string }`
  - `export interface ProjectSummary extends Project { activeKeyCount: number }`
  - `export interface RevokedApiKey { apiKey: ApiKeySummary; alreadyRevoked: boolean }`
  - `export async function createApiKey(db: Database, projectId: string): Promise<CreatedApiKey | undefined>`
  - `export async function listProjects(db: Database): Promise<ProjectSummary[]>` — ordered by `createdAt` ascending
  - `export async function listApiKeys(db: Database, projectId: string): Promise<ApiKeySummary[]>` — ordered by `createdAt` ascending
  - `export async function revokeApiKey(db: Database, keyId: string): Promise<RevokedApiKey | undefined>`
  - All functions assume ids are well-formed UUIDs (callers validate; the CLI does in Task 4).

- [x] **Step 1: Write the failing tests**

In `server/src/db/projects.test.ts`, replace the `./projects` import line with:

```ts
import {
  createApiKey,
  createProject,
  findProjectByApiKey,
  listApiKeys,
  listProjects,
  revokeApiKey,
} from "./projects";
```

and append these `describe` blocks to the end of the file:

```ts
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

describe("createApiKey", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("mints an additional key; old and new keys both resolve to the project", async () => {
    const db = getTestDb();
    const { project, key: firstKey } = await createTestProject(db);

    const created = await createApiKey(db, project.id);

    expect(created).toBeDefined();
    expect(created!.key).not.toBe(firstKey);
    expect(created!.apiKey.projectId).toBe(project.id);
    expect(created!.apiKey.prefix).toBe(created!.key.slice(0, 12));
    expect((await findProjectByApiKey(db, firstKey))?.id).toBe(project.id);
    expect((await findProjectByApiKey(db, created!.key))?.id).toBe(project.id);
  });

  it("returns undefined for a project that doesn't exist", async () => {
    const db = getTestDb();
    expect(await createApiKey(db, MISSING_ID)).toBeUndefined();
    expect(await db.select().from(apiKeys)).toHaveLength(0);
  });

  it("never returns the stored hash", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const created = await createApiKey(db, project.id);
    expect(created!.apiKey).not.toHaveProperty("keyHash");
  });
});

describe("listProjects", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns an empty list when there are no projects", async () => {
    expect(await listProjects(getTestDb())).toEqual([]);
  });

  it("counts only active keys, including projects with none active", async () => {
    const db = getTestDb();
    const { project: alpha } = await createTestProject(db, "alpha");
    await createApiKey(db, alpha.id);
    const { project: beta } = await createTestProject(db, "beta");
    const [betaKey] = await listApiKeys(db, beta.id);
    await revokeApiKey(db, betaKey.id);

    const result = await listProjects(db);

    expect(result.map((p) => [p.name, p.activeKeyCount])).toEqual([
      ["alpha", 2],
      ["beta", 0],
    ]);
    expect(result[0].id).toBe(alpha.id);
    expect(result[0].createdAt).toBeInstanceOf(Date);
  });
});

describe("listApiKeys", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("lists a project's keys oldest first, without hashes", async () => {
    const db = getTestDb();
    const { project, key: firstKey } = await createTestProject(db);
    const second = await createApiKey(db, project.id);
    await createTestProject(db, "other"); // must not appear

    const keys = await listApiKeys(db, project.id);

    expect(keys.map((k) => k.prefix)).toEqual([firstKey.slice(0, 12), second!.key.slice(0, 12)]);
    for (const k of keys) {
      expect(k).not.toHaveProperty("keyHash");
      expect(k.revokedAt).toBeNull();
    }
  });

  it("returns an empty list for an unknown project", async () => {
    expect(await listApiKeys(getTestDb(), MISSING_ID)).toEqual([]);
  });
});

describe("revokeApiKey", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("revokes a key so it no longer authenticates", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db);
    const [summary] = await listApiKeys(db, project.id);

    const result = await revokeApiKey(db, summary.id);

    expect(result?.alreadyRevoked).toBe(false);
    expect(result?.apiKey.id).toBe(summary.id);
    expect(result?.apiKey.revokedAt).toBeInstanceOf(Date);
    expect(await findProjectByApiKey(db, key)).toBeUndefined();
  });

  it("is idempotent and keeps the original revokedAt", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const [summary] = await listApiKeys(db, project.id);

    const first = await revokeApiKey(db, summary.id);
    const second = await revokeApiKey(db, summary.id);

    expect(second?.alreadyRevoked).toBe(true);
    expect(second?.apiKey.revokedAt?.getTime()).toBe(first?.apiKey.revokedAt?.getTime());
  });

  it("leaves the project's other keys working", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const [oldKey] = await listApiKeys(db, project.id);
    const replacement = await createApiKey(db, project.id);

    await revokeApiKey(db, oldKey.id);

    expect((await findProjectByApiKey(db, replacement!.key))?.id).toBe(project.id);
  });

  it("returns undefined for an unknown key id", async () => {
    expect(await revokeApiKey(getTestDb(), MISSING_ID)).toBeUndefined();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run (from `server/`): `npx vitest run src/db/projects.test.ts`
Expected: FAIL — `createApiKey`, `listProjects`, `listApiKeys`, `revokeApiKey` are not exported.

- [x] **Step 3: Implement the service functions**

In `server/src/db/projects.ts`, change the imports to:

```ts
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client";
import { apiKeys, projects, type ApiKey, type Project } from "./schema";
import { generateApiKey, hashApiKey } from "../keys";
```

Then add, below `CreatedProject`:

```ts
/** A key as it may be shown to users — everything except the hash. */
export type ApiKeySummary = Pick<ApiKey, "id" | "projectId" | "prefix" | "createdAt" | "revokedAt">;

export interface CreatedApiKey {
  apiKey: ApiKeySummary;
  /** Plaintext key — returned once, never stored. */
  key: string;
}

export interface ProjectSummary extends Project {
  activeKeyCount: number;
}

export interface RevokedApiKey {
  apiKey: ApiKeySummary;
  /** True when the key was already revoked; `apiKey.revokedAt` is then the original time. */
  alreadyRevoked: boolean;
}

const apiKeySummaryColumns = {
  id: apiKeys.id,
  projectId: apiKeys.projectId,
  prefix: apiKeys.prefix,
  createdAt: apiKeys.createdAt,
  revokedAt: apiKeys.revokedAt,
};
```

and append at the end of the file:

```ts
export async function createApiKey(db: Database, projectId: string): Promise<CreatedApiKey | undefined> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    return undefined;
  }
  const generated = generateApiKey();
  const [apiKey] = await db
    .insert(apiKeys)
    .values({ projectId, keyHash: generated.hash, prefix: generated.prefix })
    .returning(apiKeySummaryColumns);
  return { apiKey, key: generated.key };
}

export async function listProjects(db: Database): Promise<ProjectSummary[]> {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
      activeKeyCount: sql<number>`count(${apiKeys.id}) filter (where ${apiKeys.revokedAt} is null)`.mapWith(Number),
    })
    .from(projects)
    .leftJoin(apiKeys, eq(apiKeys.projectId, projects.id))
    .groupBy(projects.id)
    .orderBy(asc(projects.createdAt));
}

export async function listApiKeys(db: Database, projectId: string): Promise<ApiKeySummary[]> {
  return db
    .select(apiKeySummaryColumns)
    .from(apiKeys)
    .where(eq(apiKeys.projectId, projectId))
    .orderBy(asc(apiKeys.createdAt));
}

export async function revokeApiKey(db: Database, keyId: string): Promise<RevokedApiKey | undefined> {
  // Only stamp keys that aren't revoked yet, so a repeat revoke keeps the original time.
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning(apiKeySummaryColumns);
  if (revoked) {
    return { apiKey: revoked, alreadyRevoked: false };
  }
  const [existing] = await db.select(apiKeySummaryColumns).from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
  return existing ? { apiKey: existing, alreadyRevoked: true } : undefined;
}
```

Note on ordering: keys created in the same test can share a `created_at` down to the microsecond only in theory; `defaultNow()` is per-statement and each insert is its own statement, so ascending `created_at` is stable here. If the `listApiKeys` ordering test is ever flaky, add `asc(apiKeys.id)` as a secondary sort key rather than weakening the assertion.

- [x] **Step 4: Run the tests to verify they pass**

Run (from `server/`): `npx vitest run src/db/projects.test.ts`
Expected: PASS (all `createProject`, `findProjectByApiKey`, `createApiKey`, `listProjects`, `listApiKeys`, `revokeApiKey` tests).

- [x] **Step 5: Full suite, lint, typecheck, commit**

Run: `npm test -w server && npm run lint -w server && npm run typecheck -w server`
Expected: all pass.

```bash
git add server/src/db/projects.ts server/src/db/projects.test.ts
git commit -m "feat(server): add API key rotation, listing, and revocation service functions"
```

---

### Task 4: Operator CLI

**Files:**
- Create: `server/src/db/migrate.ts`, `server/src/db/migrate.test.ts`
- Modify: `server/src/index.ts`
- Create: `server/src/admin.ts`, `server/src/admin.test.ts`
- Create: `server/src/cli.ts`
- Modify: `server/package.json` (add `admin` script)
- Modify: `server/README.md` ("Getting an API key" section)

**Interfaces:**
- Consumes: `createProject`, `createApiKey`, `listProjects`, `listApiKeys`, `revokeApiKey`, `findProjectByApiKey` (Tasks 2–3, `server/src/db/projects.ts`); `createDb`, `Database` (`server/src/db/client.ts`); `resetDb`, `getTestDb`, `createTestProject` (`server/test/db.ts`).
- Produces:
  - `server/src/db/migrate.ts`: `export async function runMigrations(databaseUrl: string): Promise<void>`
  - `server/src/admin.ts`: `export interface CliOutput { stdout(line: string): void; stderr(line: string): void }`, `export const USAGE: string`, `export async function runCli(argv: string[], db: Database, out: CliOutput): Promise<number>` (resolves to the exit code; throws only on unexpected errors).
  - `server/dist/cli.js` runnable as `node server/dist/cli.js <command>`.

- [x] **Step 1: Write the failing `runMigrations` test**

Create `server/src/db/migrate.test.ts`:

```ts
import { describe, it, expect, inject } from "vitest";
import { runMigrations } from "./migrate";

describe("runMigrations", () => {
  it("resolves the migrations folder and is a no-op on an already-migrated database", async () => {
    // globalSetup has already applied every migration to this database.
    await expect(runMigrations(inject("databaseUrl"))).resolves.toBeUndefined();
  });
});
```

Run (from `server/`): `npx vitest run src/db/migrate.test.ts`
Expected: FAIL — cannot resolve `./migrate`.

- [x] **Step 2: Extract `runMigrations` and use it from the server entrypoint**

Create `server/src/db/migrate.ts`:

```ts
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

// Shared by the server and the admin CLI. Drizzle skips migrations that are
// already applied, so running this from both entrypoints is safe.
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), {
      // src/db/migrate.ts and dist/db/migrate.js both sit two levels below server/.
      migrationsFolder: path.join(__dirname, "..", "..", "drizzle"),
    });
  } finally {
    await pool.end();
  }
}
```

In `server/src/index.ts`:
- Remove the imports `import path from "node:path";`, `import { drizzle } from "drizzle-orm/node-postgres";`, `import { migrate } from "drizzle-orm/node-postgres/migrator";`, `import { Pool } from "pg";`.
- Add `import { runMigrations } from "./db/migrate";`.
- Replace
  ```ts
  const migrationPool = new Pool({ connectionString: databaseUrl });
  await migrate(drizzle(migrationPool), {
    migrationsFolder: path.join(__dirname, "..", "drizzle"),
  });
  await migrationPool.end();
  ```
  with
  ```ts
  await runMigrations(databaseUrl);
  ```

Run (from `server/`): `npx vitest run src/db/migrate.test.ts`
Expected: PASS.

- [x] **Step 3: Write the failing CLI tests**

Create `server/src/admin.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, resetDb } from "../test/db";
import { findProjectByApiKey, listApiKeys, listProjects, revokeApiKey } from "./db/projects";
import { runCli, USAGE } from "./admin";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";
const KEY_PATTERN = /^rpk_[A-Za-z0-9_-]{43}$/;

async function run(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, getTestDb(), {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe("runCli", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  describe("command shape errors", () => {
    it("exits 2 with usage when no command is given", async () => {
      const result = await run([]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Missing command", USAGE]);
    });

    it("exits 2 with usage for an unknown command", async () => {
      const result = await run(["project", "delete"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Unknown command: project delete", USAGE]);
    });

    it("exits 2 with usage for a missing argument", async () => {
      const result = await run(["project", "create"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Missing argument: <name>", USAGE]);
    });

    it("exits 2 with usage for an extra argument", async () => {
      const result = await run(["project", "create", "My", "Project"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Unexpected argument: Project", USAGE]);
    });

    it("exits 2 with usage for an unknown flag", async () => {
      const result = await run(["project", "list", "--json"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toHaveLength(2);
      expect(result.stderr[0]).toContain("--json");
      expect(result.stderr[1]).toBe(USAGE);
    });
  });

  describe("project create", () => {
    it("creates the project and prints its id and a working key once", async () => {
      const result = await run(["project", "create", "Acme"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toEqual([]);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("Acme");
      expect(result.stdout[0]).toBe(`Created project "Acme" (${project.id})`);
      expect(result.stdout[1]).toMatch(KEY_PATTERN);
      expect(result.stdout[2]).toBe("Store this API key now. It will not be shown again.");
      expect((await findProjectByApiKey(getTestDb(), result.stdout[1]))?.id).toBe(project.id);
    });

    it("trims the project name", async () => {
      await run(["project", "create", "  Acme  "]);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("Acme");
    });

    it("exits 2 without usage for a whitespace-only name", async () => {
      const result = await run(["project", "create", "   "]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Project name is required"]);
      expect(await listProjects(getTestDb())).toEqual([]);
    });
  });

  describe("project list", () => {
    it("prints a message when there are no projects", async () => {
      const result = await run(["project", "list"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual(["No projects."]);
    });

    it("prints a table of projects with active key counts and no keys", async () => {
      const { project, key } = await createTestProject(getTestDb(), "Acme");

      const result = await run(["project", "list"]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toMatch(/^ID\s+NAME\s+CREATED\s+ACTIVE KEYS$/);
      expect(result.stdout[1]).toContain(project.id);
      expect(result.stdout[1]).toContain("Acme");
      expect(result.stdout[1]).toContain(project.createdAt.toISOString());
      expect(result.stdout[1]).toMatch(/\s1$/);
      expect(result.stdout.join("\n")).not.toContain(key);
    });
  });

  describe("key create", () => {
    it("mints a new working key and prints it once", async () => {
      const { project } = await createTestProject(getTestDb());

      const result = await run(["key", "create", project.id]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toBe(`Created API key for project ${project.id}`);
      expect(result.stdout[1]).toMatch(KEY_PATTERN);
      expect(result.stdout[2]).toBe("Store this API key now. It will not be shown again.");
      expect((await findProjectByApiKey(getTestDb(), result.stdout[1]))?.id).toBe(project.id);
    });

    it("exits 1 for a project that doesn't exist", async () => {
      const result = await run(["key", "create", MISSING_ID]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual([`Project not found: ${MISSING_ID}`]);
    });

    it("exits 2 without usage for a malformed id", async () => {
      const result = await run(["key", "create", "not-a-uuid"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: not-a-uuid"]);
    });
  });

  describe("key list", () => {
    it("prints prefixes and revocation times but never full keys", async () => {
      const db = getTestDb();
      const { project, key } = await createTestProject(db);
      const [summary] = await listApiKeys(db, project.id);
      const revoked = await revokeApiKey(db, summary.id);

      const result = await run(["key", "list", project.id]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toMatch(/^ID\s+PREFIX\s+CREATED\s+REVOKED$/);
      expect(result.stdout[1]).toContain(summary.id);
      expect(result.stdout[1]).toContain(key.slice(0, 12));
      expect(result.stdout[1]).toContain(revoked!.apiKey.revokedAt!.toISOString());
      expect(result.stdout.join("\n")).not.toContain(key);
    });

    it("shows a dash for active keys", async () => {
      const { project } = await createTestProject(getTestDb());
      const result = await run(["key", "list", project.id]);
      expect(result.stdout[1]).toMatch(/\s-$/);
    });

    it("prints a message when the project has no keys", async () => {
      const result = await run(["key", "list", MISSING_ID]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual(["No API keys."]);
    });

    it("exits 2 without usage for a malformed id", async () => {
      const result = await run(["key", "list", "nope"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: nope"]);
    });
  });

  describe("key revoke", () => {
    it("revokes the key", async () => {
      const db = getTestDb();
      const { project, key } = await createTestProject(db);
      const [summary] = await listApiKeys(db, project.id);

      const result = await run(["key", "revoke", summary.id]);

      expect(result.code).toBe(0);
      expect(result.stdout).toEqual([`Revoked key ${summary.prefix} (${summary.id})`]);
      expect(await findProjectByApiKey(db, key)).toBeUndefined();
    });

    it("exits 0 and reports the original time when already revoked", async () => {
      const db = getTestDb();
      const { project } = await createTestProject(db);
      const [summary] = await listApiKeys(db, project.id);
      const first = await revokeApiKey(db, summary.id);

      const result = await run(["key", "revoke", summary.id]);

      expect(result.code).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(result.stdout).toEqual([
        `Key ${summary.prefix} already revoked at ${first!.apiKey.revokedAt!.toISOString()}`,
      ]);
    });

    it("exits 1 for an unknown key", async () => {
      const result = await run(["key", "revoke", MISSING_ID]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual([`Key not found: ${MISSING_ID}`]);
    });

    it("exits 2 without usage for a malformed id", async () => {
      const result = await run(["key", "revoke", "123"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: 123"]);
    });
  });
});
```

Run (from `server/`): `npx vitest run src/admin.test.ts`
Expected: FAIL — cannot resolve `./admin`.

- [x] **Step 4: Implement `runCli`**

Create `server/src/admin.ts`:

```ts
import { parseArgs } from "node:util";
import type { Database } from "./db/client";
import { createApiKey, createProject, listApiKeys, listProjects, revokeApiKey } from "./db/projects";

export interface CliOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const USAGE = `Usage: repro-admin <command>

Commands:
  project create <name>      Create a project and its first API key
  project list               List projects
  key create <projectId>     Create an additional API key for a project
  key list <projectId>       List a project's API keys
  key revoke <keyId>         Revoke an API key`;

const KEY_WARNING = "Store this API key now. It will not be shown again.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly showUsage = false
  ) {
    super(message);
  }
}

// Returns the process exit code. Expected failures (bad input, not found) are
// reported via `out` and an exit code; anything else is thrown to the caller.
export async function runCli(argv: string[], db: Database, out: CliOutput): Promise<number> {
  try {
    const [group, action, ...rest] = parsePositionals(argv);
    if (!group) {
      throw new CliError("Missing command", 2, true);
    }
    switch (`${group} ${action ?? ""}`) {
      case "project create":
        return await projectCreate(db, out, singleArg(rest, "<name>"));
      case "project list":
        noArgs(rest);
        return await projectList(db, out);
      case "key create":
        return await keyCreate(db, out, parseId(singleArg(rest, "<projectId>")));
      case "key list":
        return await keyList(db, out, parseId(singleArg(rest, "<projectId>")));
      case "key revoke":
        return await keyRevoke(db, out, parseId(singleArg(rest, "<keyId>")));
      default:
        throw new CliError(`Unknown command: ${[group, action].filter(Boolean).join(" ")}`, 2, true);
    }
  } catch (error) {
    if (!(error instanceof CliError)) {
      throw error;
    }
    out.stderr(error.message);
    if (error.showUsage) {
      out.stderr(USAGE);
    }
    return error.exitCode;
  }
}

function parsePositionals(argv: string[]): string[] {
  try {
    // No options are defined, so strict mode rejects any flag (e.g. --json).
    return parseArgs({ args: argv, allowPositionals: true, strict: true }).positionals;
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 2, true);
  }
}

function singleArg(rest: string[], name: string): string {
  if (rest.length === 0) {
    throw new CliError(`Missing argument: ${name}`, 2, true);
  }
  noArgs(rest.slice(1));
  return rest[0];
}

function noArgs(rest: string[]): void {
  if (rest.length > 0) {
    throw new CliError(`Unexpected argument: ${rest[0]}`, 2, true);
  }
}

// Validated up front so Postgres never raises a uuid cast error.
function parseId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new CliError(`Invalid id: ${value}`, 2);
  }
  return value;
}

function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...rows.map(line)];
}

async function projectCreate(db: Database, out: CliOutput, rawName: string): Promise<number> {
  const name = rawName.trim();
  if (!name) {
    throw new CliError("Project name is required", 2);
  }
  const { project, key } = await createProject(db, name);
  out.stdout(`Created project "${project.name}" (${project.id})`);
  out.stdout(key);
  out.stdout(KEY_WARNING);
  return 0;
}

async function projectList(db: Database, out: CliOutput): Promise<number> {
  const projects = await listProjects(db);
  if (projects.length === 0) {
    out.stdout("No projects.");
    return 0;
  }
  const rows = projects.map((p) => [p.id, p.name, p.createdAt.toISOString(), String(p.activeKeyCount)]);
  formatTable(["ID", "NAME", "CREATED", "ACTIVE KEYS"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function keyCreate(db: Database, out: CliOutput, projectId: string): Promise<number> {
  const created = await createApiKey(db, projectId);
  if (!created) {
    throw new CliError(`Project not found: ${projectId}`, 1);
  }
  out.stdout(`Created API key for project ${projectId}`);
  out.stdout(created.key);
  out.stdout(KEY_WARNING);
  return 0;
}

async function keyList(db: Database, out: CliOutput, projectId: string): Promise<number> {
  const keys = await listApiKeys(db, projectId);
  if (keys.length === 0) {
    out.stdout("No API keys.");
    return 0;
  }
  const rows = keys.map((k) => [k.id, k.prefix, k.createdAt.toISOString(), k.revokedAt?.toISOString() ?? "-"]);
  formatTable(["ID", "PREFIX", "CREATED", "REVOKED"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function keyRevoke(db: Database, out: CliOutput, keyId: string): Promise<number> {
  const result = await revokeApiKey(db, keyId);
  if (!result) {
    throw new CliError(`Key not found: ${keyId}`, 1);
  }
  const { apiKey, alreadyRevoked } = result;
  if (alreadyRevoked) {
    out.stdout(`Key ${apiKey.prefix} already revoked at ${apiKey.revokedAt!.toISOString()}`);
  } else {
    out.stdout(`Revoked key ${apiKey.prefix} (${apiKey.id})`);
  }
  return 0;
}
```

- [x] **Step 5: Run the CLI tests to verify they pass**

Run (from `server/`): `npx vitest run src/admin.test.ts`
Expected: PASS. If the unknown-flag test fails only because Node's `parseArgs` message wording differs, fix the test's expectation of `stderr[0]` to match the installed Node's message — the assertion that matters is that it names `--json`, exits 2, and prints usage.

- [x] **Step 6: Add the process entrypoint and `admin` script**

Create `server/src/cli.ts`:

```ts
import { createDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { runCli } from "./admin";

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    return 1;
  }

  // Lets `project create` work against a fresh database before the server has booted.
  await runMigrations(databaseUrl);

  const db = createDb(databaseUrl);
  try {
    return await runCli(process.argv.slice(2), db, {
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });
  } finally {
    await db.$client.end();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  }
);
```

`drizzle-orm` ≥ 0.33 exposes the underlying `pg` `Pool` as `db.$client`. If the installed version's types don't, don't change `createDb`'s return type (every caller uses it). Instead, add `export function createDbFromPool(pool: Pool)` to `server/src/db/client.ts`, have `createDb` delegate to it, and have `cli.ts` construct the `Pool` itself and call `pool.end()` in the `finally`. Note the discrepancy in your task report.

In `server/package.json`, add to `"scripts"` (after `"start"`):

```json
"admin": "npm run build --silent && node dist/cli.js",
```

- [x] **Step 7: Verify the built CLI's missing-`DATABASE_URL` path**

Run (from repo root): `npm run build -w server && node server/dist/cli.js project list; echo "exit=$?"`
Expected (no `DATABASE_URL` set): stderr `DATABASE_URL is required`, `exit=1`.

- [x] **Step 8: Update the server README**

In `server/README.md`, replace the entire `## Getting an API key` section (from that heading up to, not including, `## Environment variables`) with:

````markdown
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

````

- [x] **Step 9: Full suite, lint, typecheck, commit**

Run: `npm test -w server && npm run lint -w server && npm run typecheck -w server`
Expected: all pass.

```bash
git add server/src/db/migrate.ts server/src/db/migrate.test.ts server/src/index.ts \
  server/src/admin.ts server/src/admin.test.ts server/src/cli.ts server/package.json server/README.md
git commit -m "feat(server): add repro-admin CLI for projects and API keys"
```

---

### Task 5: Docs cross-reference, workspace verification, docker-compose smoke test

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md` (out-of-scope list and the "`apiKey` is stored as plain text" data-model note)

**Interfaces:**
- Consumes: everything from Tasks 1–4.

- [ ] **Step 1: Update the ingest spec's cross-references**

In `docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md`:

Replace the data-model bullet that begins `- **`apiKey` is stored as plain text**` (and its continuation lines) with:

```markdown
- **API keys** were originally stored as plain text in `projects.api_key`. They now
  live, hashed, in a separate `api_keys` table — see
  `2026-09-22-repro-api-keys-design.md`.
```

In `## Explicitly out of scope (future sub-projects)`, replace the two bullets beginning `- API key issuance flow` and `- Hashing API keys at rest` with:

```markdown
- API key issuance and hashing at rest — done in `2026-09-22-repro-api-keys-design.md`
  (operator CLI; dashboard self-serve is part of the dashboard sub-project).
```

- [ ] **Step 2: Full workspace verification**

Run (from repo root): `npm run build && npm test && npm run lint && npm run typecheck`
Expected: all four succeed across both `packages/js` and `server`.

- [ ] **Step 3: docker-compose smoke test**

Run: `docker compose up -d --build`
Wait until `docker compose ps` shows both containers running and `curl -s http://localhost:3000/health` returns `{"status":"ok"}`.

Create a project with the CLI and capture its id and key:

```bash
OUT=$(docker compose exec -T server node server/dist/cli.js project create smoke-test)
echo "$OUT"
PROJECT_ID=$(echo "$OUT" | sed -n 1p | sed -E 's/.*\(([0-9a-f-]+)\)$/\1/')
KEY=$(echo "$OUT" | sed -n 2p)
echo "project=$PROJECT_ID key_length=${#KEY}"
```

Expected: `$OUT` is `Created project "smoke-test" (<uuid>)`, an `rpk_...` key, and the warning line; `key_length=47`.

Send a timeline with it:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/v1/timeline \
  -H "Content-Type: application/json" \
  -H "X-Repro-Key: $KEY" \
  -d '{"sessionId":"smoke-session","reason":{"type":"manual","name":"smoke-test"},"events":[],"meta":{"url":"https://example.com","userAgent":"curl","capturedAt":1700000000000}}'
```

Expected: `201`.

Confirm the plaintext key is not in the database:

```bash
docker compose exec -T postgres psql -U repro -d repro -tAc "SELECT count(*) FROM api_keys WHERE key_hash = '$KEY' OR prefix = '$KEY';"
```

Expected: `0`.

Revoke it and retry:

```bash
KEY_ID=$(docker compose exec -T server node server/dist/cli.js key list "$PROJECT_ID" | awk 'NR==2{print $1}')
docker compose exec -T server node server/dist/cli.js key revoke "$KEY_ID"
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/v1/timeline \
  -H "Content-Type: application/json" \
  -H "X-Repro-Key: $KEY" \
  -d '{"sessionId":"smoke-session","reason":{"type":"manual","name":"smoke-test"},"events":[],"meta":{"url":"https://example.com","userAgent":"curl","capturedAt":1700000000000}}'
```

Expected: `Revoked key rpk_... (<uuid>)`, then `{"error":"Invalid API key"}` and `401`.

Run: `docker compose down -v`
Expected: clean teardown.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md
git commit -m "docs: point ingest spec's key-issuance entries at the API keys spec"
```

If Step 2 or Step 3 required code fixes, commit those separately with a `fix(server): ...` message and describe them in the task report.
