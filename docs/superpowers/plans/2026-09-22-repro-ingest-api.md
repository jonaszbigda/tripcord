# repro Ingest API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the repo to an npm-workspaces monorepo and build `server/`, a Fastify + Postgres ingest API that receives `TimelinePayload`s from `@repro/js`, validates the API key, and stores them, with fixed-TTL retention.

**Architecture:** Client library moves to `packages/js/` (unchanged internally, just relocated). `server/` is a new workspace: Fastify app built via a `buildApp(db)` factory (for testability via `.inject()`), Drizzle ORM against Postgres, JSON Schema request validation mirroring `TimelinePayload` exactly, project-based API keys, `@fastify/rate-limit` keyed by project, an in-process scheduled cleanup job, and a multi-stage Dockerfile + root `docker-compose.yml` for self-host/local dev.

**Tech Stack:** TypeScript, Fastify 5, Drizzle ORM + drizzle-kit, `pg`, `@testcontainers/postgresql` (ephemeral Postgres for tests), Vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md`

## Global Constraints

- Repo becomes an npm-workspaces monorepo: `packages/js/` (client, moved from root) + `server/` (new). Root `package.json` is private, never published.
- The server imports the client's payload types via the workspace link — `import type { TimelinePayload, TimelineEvent, TimelineReason, TimelineMeta } from "@repro/js"` — never redefines them.
- Postgres via Drizzle ORM (schema-as-code + `drizzle-kit` migrations), not Prisma, not hand-written SQL for schema/queries.
- Fastify, with `@fastify/rate-limit`; request body validation uses Fastify's built-in JSON Schema mechanism, not hand-written validation code.
- Auth: `X-Repro-Key` header looked up against `projects.apiKey`. **This lookup must run in a `preValidation` hook, not inside the route handler** — a route's declared `schema.body` validates between Fastify's `preValidation` and `preHandler` lifecycle stages, so checking auth inside the handler would let Fastify validate an unauthenticated request's body first, which the spec explicitly requires NOT to happen ("API key lookup runs before body validation, so an invalid key can't be used to probe payload validation behavior").
- `reasonType` is a plain `text` column, not a Postgres enum — validity enforced once, at ingest, via the JSON Schema.
- Two separate indexes on `timelines`: `(projectId, receivedAt)` and `(projectId, reasonType)` — not one compound index.
- Request body size limit: 256KB (`bodyLimit`).
- Retention: `RETENTION_DAYS` env var (default `30`), enforced by an in-process `setInterval`-based cleanup job — not external cron, not `pg_cron`.
- Integration tests run against a real, ephemeral Postgres via `@testcontainers/postgresql`, started once per test run (Vitest `globalSetup`), not an assumed-already-running `docker-compose` instance.
- The server's Vitest config runs test files **serially** (`fileParallelism: false`) — all integration tests share one testcontainers-provisioned Postgres for the whole run, and each test cleans up its own rows; parallel file execution against a shared database would risk cross-file interference.
- Error responses use a consistent `{ error: "message" }` JSON shape across 4xx/5xx.
- The client library's transport is fire-and-forget (never reads the response body or status code) — the ingest response contract exists for testability/debugging, not because the current client consumes it.
- **API-surface caveat:** a few tasks below (testcontainers wiring, `@fastify/rate-limit`'s per-route hook override) use less-common plugin APIs. The code shown is this plan's best understanding of the installed package versions. If an installed package's own TypeScript types disagree with a method/option name shown here, trust the installed package's types, adapt the code accordingly, and note the discrepancy in your task report — don't block on it, and don't silently force a mismatch either.

---

## File Structure

```
package.json                    # root: workspaces + proxy scripts
README.md                       # new: monorepo overview
LICENSE                         # unchanged, stays at root
docs/                           # unchanged, stays at root
packages/
  js/                           # moved from repo root, unchanged internally
    src/ tsconfig.json tsup.config.ts vitest.config.ts eslint.config.js
    package.json README.md
server/
  package.json tsconfig.json vitest.config.ts eslint.config.js Dockerfile
  drizzle.config.ts
  drizzle/                      # generated SQL migrations
  src/
    index.ts                    # entry point: build db, migrate, build app, listen, schedule cleanup
    app.ts                      # buildApp(db) factory
    retention.ts                # cleanupOldTimelines() + scheduleCleanup()
    db/
      schema.ts                 # projects, timelines tables
      client.ts                 # createDb()
      projects.ts                # findProjectByApiKey()
    routes/
      timeline.ts                 # POST /v1/timeline
  test/
    globalSetup.ts               # testcontainers Postgres + migrate, once per run
    db.ts                        # getTestDb() helper
docker-compose.yml                # root: server + postgres
```

---

### Task 1: Monorepo conversion — move client library into `packages/js/`

**Files:**
- Move (git mv): `src/` → `packages/js/src/`, `tsconfig.json` → `packages/js/tsconfig.json`, `tsup.config.ts` → `packages/js/tsup.config.ts`, `vitest.config.ts` → `packages/js/vitest.config.ts`, `eslint.config.js` → `packages/js/eslint.config.js`, `package.json` → `packages/js/package.json`, `README.md` → `packages/js/README.md`
- Create: `package.json` (new, at root)
- Create: `README.md` (new, at root)

**Interfaces:**
- Produces: an npm-workspaces root with `"workspaces": ["packages/*"]`, and `@repro/js` fully functional from its new location.

This task moves already-shipped, already-pushed code. There is no new feature here — the "test" is proving the existing suite still passes unchanged after the move.

- [x] **Step 1: Move the files**

```bash
git mv src packages/js/src
git mv tsconfig.json packages/js/tsconfig.json
git mv tsup.config.ts packages/js/tsup.config.ts
git mv vitest.config.ts packages/js/vitest.config.ts
git mv eslint.config.js packages/js/eslint.config.js
git mv package.json packages/js/package.json
git mv README.md packages/js/README.md
```

- [x] **Step 2: Create the new root `package.json`**

```json
{
  "name": "repro",
  "private": true,
  "version": "0.0.0",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

- [x] **Step 3: Create the new root `README.md`**

```markdown
# repro

Monorepo for `repro` — an opt-in, developer-instrumented breadcrumb timeline for
frontend bug reproduction.

## Packages

- [`packages/js`](packages/js) — `@repro/js`, the browser client library. Built,
  tested, not yet published to npm.
- `server` — the ingest API that receives what the client sends. Coming soon.

See each package's own README for details, and
[`docs/superpowers/specs/`](docs/superpowers/specs) for design rationale.

## Development

This is an npm workspaces monorepo.

```bash
npm install          # installs all workspaces
npm test              # runs tests in every workspace
npm run build          # builds every workspace
npm run lint             # lints every workspace
```

To work on a single package: `npm test -w packages/js` or `cd packages/js && npm test`.

## License

MIT — see [`LICENSE`](LICENSE).
```

- [x] **Step 4: Install and verify**

Run: `npm install` (from repo root)
Expected: succeeds, `package-lock.json` is rewritten to reflect the workspace layout, a single root `node_modules/` is created.

Run: `npm run build -w packages/js && npm test -w packages/js && npm run lint -w packages/js && npm run typecheck -w packages/js`
Expected: all four succeed exactly as they did before the move (build produces `packages/js/dist/*`, 50 tests pass, lint clean, typecheck clean).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: convert repo to npm workspaces, move client library to packages/js"
```

---

### Task 2: Server workspace scaffolding

**Files:**
- Modify: `package.json` (root) — add `"server"` to `workspaces`
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/eslint.config.js`
- Create: `server/src/index.ts` (placeholder, replaced in Task 6)
- Test: `server/src/index.test.ts` (placeholder, replaced in Task 6)

**Interfaces:**
- Produces: a working `server` workspace toolchain (build/test/lint/typecheck), proven with a trivial smoke test before any real app code exists — same pattern as the client library's own Task 1.

- [x] **Step 1: Write the failing test**

`server/src/index.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { VERSION } from "./index";

describe("server toolchain smoke test", () => {
  it("exports a version string", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
```

- [x] **Step 2: Add `server` to the root workspaces list**

Modify `package.json` (root):
```json
  "workspaces": [
    "packages/*",
    "server"
  ],
```

- [x] **Step 3: Create the server's config files**

`server/package.json`:
```json
{
  "name": "@repro/server",
  "private": true,
  "version": "0.0.1",
  "type": "commonjs",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "fastify": "^5.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@types/node": "^22.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "globals": "^17.12.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "CommonJS",
    "moduleResolution": "Node",
    "declaration": false,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

`server/eslint.config.js` (mirrors the lessons already learned building `packages/js`: no-unused-vars must be the TS-aware variant from the start, and globals must be set from the start — no need to rediscover either gap here):
```js
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module" },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
```

`server/src/index.ts` (placeholder — Task 6 replaces this with the real entry point):
```ts
export const VERSION = "0.0.1";
```

- [x] **Step 4: Install and run**

Run: `npm install` (from repo root)
Expected: succeeds, `server` now appears in the workspace-aware `node_modules`/lockfile.

Run: `npm test -w server`
Expected: PASS — 1 test passed.

Run: `npm run build -w server && npm run lint -w server && npm run typecheck -w server`
Expected: build produces `server/dist/index.js`; lint and typecheck both clean.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json server/package.json server/tsconfig.json server/vitest.config.ts server/eslint.config.js server/src/index.ts server/src/index.test.ts
git commit -m "chore: scaffold @repro/server workspace (build, test, lint toolchain)"
```

---

### Task 3: Drizzle schema and initial migration

**Files:**
- Modify: `server/package.json` (add `drizzle-orm`, `pg` deps; `drizzle-kit`, `@types/pg` devDeps)
- Create: `server/drizzle.config.ts`
- Create: `server/src/db/schema.ts`
- Create: `server/src/db/client.ts`

**Interfaces:**
- Produces: `projects` table (`id`, `name`, `apiKey`, `createdAt`), `timelines` table (`id`, `projectId`, `sessionId`, `reasonType`, `reason`, `events`, `meta`, `receivedAt`), `createDb(connectionString): Database`, `export type Database = ReturnType<typeof createDb>`.
- Consumed by: Task 4 (test infra runs migrations against this schema), Task 5 (`findProjectByApiKey` queries `projects`), Task 7 (ingest route inserts into `timelines`), Task 9 (cleanup job deletes from `timelines`).

There's no live database to test against yet (that's Task 4) — this task's verification is that the schema compiles, and that `drizzle-kit generate` produces the expected SQL.

- [x] **Step 1: Add dependencies**

Modify `server/package.json` — add to `"dependencies"`:
```json
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0"
```
Add to `"devDependencies"`:
```json
    "@types/pg": "^8.11.0",
    "drizzle-kit": "^0.28.0"
```

Run: `npm install` (from repo root)

- [x] **Step 2: Write the schema**

`server/src/db/schema.ts`:
```ts
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
export type Timeline = typeof timelines.$inferSelect;
```

`server/src/db/client.ts`:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
```

- [x] **Step 3: Configure drizzle-kit and generate the initial migration**

`server/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder/placeholder",
  },
});
```

Run (from `server/`): `npx drizzle-kit generate`
Expected: creates `server/drizzle/0000_<generated_name>.sql` containing `CREATE TABLE "projects" (...)` and `CREATE TABLE "timelines" (...)` statements, plus a `server/drizzle/meta/` snapshot directory.

Verify: `grep -l 'CREATE TABLE "projects"' server/drizzle/*.sql` and `grep -l 'CREATE TABLE "timelines"' server/drizzle/*.sql` both find the generated file.

- [x] **Step 4: Verify the server workspace still builds and typechecks**

Run: `npm run typecheck -w server && npm run build -w server && npm run lint -w server`
Expected: all clean.

- [x] **Step 5: Commit**

```bash
git add server/package.json package-lock.json server/drizzle.config.ts server/src/db/schema.ts server/src/db/client.ts server/drizzle
git commit -m "feat(server): add Drizzle schema (projects, timelines) and initial migration"
```

---

### Task 4: Testcontainers test infrastructure and first real DB test

**Files:**
- Modify: `server/package.json` (add `@testcontainers/postgresql` devDep)
- Modify: `server/vitest.config.ts` (add `globalSetup`, `fileParallelism: false`)
- Create: `server/test/globalSetup.ts`
- Create: `server/test/db.ts`
- Test: `server/src/db/schema.test.ts`

**Interfaces:**
- Produces: `getTestDb(): Database`, usable from any test file after `globalSetup` has run. `vitest`'s `ProvidedContext` gains a `databaseUrl: string` key.
- Consumed by: Task 5, Task 7, Task 9's tests.

- [x] **Step 1: Add the testcontainers dependency**

Modify `server/package.json` — add to `"devDependencies"`:
```json
    "@testcontainers/postgresql": "^10.13.0"
```

Run: `npm install` (from repo root)

- [x] **Step 2: Write the failing test**

`server/src/db/schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { getTestDb } from "../../test/db";
import { projects } from "./schema";

describe("schema wiring", () => {
  it("can insert a project and read it back", async () => {
    const db = getTestDb();

    const [inserted] = await db
      .insert(projects)
      .values({ name: "test project", apiKey: "test-key-123" })
      .returning();

    const found = await db.query.projects.findFirst({
      where: (p, { eq }) => eq(p.id, inserted.id),
    });

    expect(found?.name).toBe("test project");
    expect(found?.apiKey).toBe("test-key-123");
  });
});
```

- [x] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/db/schema.test.ts` (from `server/`)
Expected: FAIL — cannot find module `../../test/db` (doesn't exist yet).

- [x] **Step 4: Write the test infrastructure**

`server/test/globalSetup.ts`:
```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";

let container: StartedPostgreSqlContainer;

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const connectionString = container.getConnectionUri();

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();

  project.provide("databaseUrl", connectionString);
}

export async function teardown(): Promise<void> {
  await container.stop();
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
```

`server/test/db.ts`:
```ts
import { inject } from "vitest";
import { createDb, type Database } from "../src/db/client";

export function getTestDb(): Database {
  return createDb(inject("databaseUrl"));
}
```

Modify `server/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./test/globalSetup.ts",
    fileParallelism: false,
  },
});
```

- [x] **Step 5: Run it to verify it passes**

Run: `npm test -w server`
Expected: PASS. This will take longer than previous test runs (pulling/starting a real Postgres Docker container) — that's expected the first time; subsequent runs reuse the cached image.

- [x] **Step 6: Commit**

```bash
git add server/package.json package-lock.json server/vitest.config.ts server/test/globalSetup.ts server/test/db.ts server/src/db/schema.test.ts
git commit -m "test(server): add testcontainers Postgres test infrastructure"
```

---

### Task 5: Project lookup by API key

**Files:**
- Create: `server/src/db/projects.ts`
- Test: `server/src/db/projects.test.ts`

**Interfaces:**
- Consumes: `Database`, `Project` (Task 3), `getTestDb` (Task 4), `projects` table (Task 3).
- Produces: `findProjectByApiKey(db: Database, apiKey: string): Promise<Project | undefined>`.
- Consumed by: Task 7 (ingest route's `preValidation` auth check).

- [x] **Step 1: Write the failing test**

`server/src/db/projects.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb } from "../../test/db";
import { projects, timelines } from "./schema";
import { findProjectByApiKey } from "./projects";

describe("findProjectByApiKey", () => {
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(timelines);
    await db.delete(projects);
  });

  it("returns the project when the api key matches", async () => {
    const db = getTestDb();
    const [inserted] = await db
      .insert(projects)
      .values({ name: "widgets-inc", apiKey: "key-abc" })
      .returning();

    const found = await findProjectByApiKey(db, "key-abc");

    expect(found?.id).toBe(inserted.id);
    expect(found?.name).toBe("widgets-inc");
  });

  it("returns undefined when no project has that api key", async () => {
    const db = getTestDb();
    const found = await findProjectByApiKey(db, "no-such-key");
    expect(found).toBeUndefined();
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/db/projects.test.ts` (from `server/`)
Expected: FAIL — cannot find module `./projects`.

- [x] **Step 3: Write the implementation**

`server/src/db/projects.ts`:
```ts
import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { projects, type Project } from "./schema";

export async function findProjectByApiKey(db: Database, apiKey: string): Promise<Project | undefined> {
  const [found] = await db.select().from(projects).where(eq(projects.apiKey, apiKey)).limit(1);
  return found;
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npm test -w server`
Expected: PASS — all tests including the 2 new ones.

- [x] **Step 5: Commit**

```bash
git add server/src/db/projects.ts server/src/db/projects.test.ts
git commit -m "feat(server): add findProjectByApiKey()"
```

---

### Task 6: Fastify app, db wiring, and migrate-on-boot

**Files:**
- Modify: `server/src/index.ts` (replaces the Task 2 placeholder)
- Modify: `server/src/index.test.ts` (replaces the Task 2 placeholder test)
- Create: `server/src/app.ts`
- Test: `server/src/app.test.ts`

**Interfaces:**
- Consumes: `Database`, `createDb` (Task 3).
- Produces: `buildApp(db: Database): FastifyInstance` (exposes `GET /health`; Task 7 adds the ingest route onto the same app), a real `server/src/index.ts` entry point that connects to Postgres, runs pending migrations, builds the app, and listens.
- Consumed by: Task 7 (adds a route inside `buildApp`), Task 8 (rate-limit registration inside `buildApp`), Task 10 (Docker `CMD` runs this entry point).

- [x] **Step 1: Write the failing test**

`server/src/app.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { getTestDb } from "../test/db";
import { buildApp } from "./app";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = buildApp(getTestDb());
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app.test.ts` (from `server/`)
Expected: FAIL — cannot find module `./app`.

- [x] **Step 3: Write the implementation**

`server/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/client";

export function buildApp(db: Database): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Task 7 registers POST /v1/timeline onto this same `app`, using `db`.
  void db;

  return app;
}
```

Replace `server/src/index.ts`:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "./db/client";
import { buildApp } from "./app";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const migrationPool = new Pool({ connectionString: databaseUrl });
  await migrate(drizzle(migrationPool), { migrationsFolder: "./drizzle" });
  await migrationPool.end();

  const db = createDb(databaseUrl);
  const app = buildApp(db);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("[repro-server] failed to start:", error);
  process.exit(1);
});
```

Replace `server/src/index.test.ts` — the toolchain smoke test is superseded by `app.test.ts`'s real behavioral test, so delete this file entirely rather than replacing its content:
```bash
rm server/src/index.test.ts
```

- [x] **Step 4: Run it to verify it passes**

Run: `npm test -w server`
Expected: PASS — all tests.

Run: `npm run typecheck -w server && npm run build -w server && npm run lint -w server`
Expected: all clean.

- [x] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/app.test.ts server/src/index.ts
git rm server/src/index.test.ts
git commit -m "feat(server): add Fastify app factory, db wiring, and migrate-on-boot"
```

---

### Task 7: Ingest route — `POST /v1/timeline`

**Files:**
- Create: `server/src/routes/timeline.ts`
- Modify: `server/src/app.ts` (registers the route)
- Test: `server/src/routes/timeline.test.ts`

**Interfaces:**
- Consumes: `Database`, `findProjectByApiKey` (Task 5), `timelines` table (Task 3), `buildApp` (Task 6), `TimelinePayload`/`TimelineEvent`/`TimelineReason`/`TimelineMeta` from `@repro/js` (the workspace-linked client package).
- Produces: `registerTimelineRoute(app: FastifyInstance, db: Database): void`, mounting `POST /v1/timeline`.

**Read the Global Constraints section's note on `preValidation` before writing this file** — the API key check MUST run in a `preValidation` hook, not inside the main handler function, or Fastify's automatic body-schema validation will run against an unauthenticated request's body first.

- [x] **Step 1: Write the failing test**

`server/src/routes/timeline.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb } from "../../test/db";
import { projects, timelines } from "../db/schema";
import { buildApp } from "../app";

const validPayload = {
  sessionId: "session-1",
  reason: { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
  events: [{ timestamp: 1, type: "custom", name: "checkout.step" }],
  meta: { url: "https://example.com/checkout", userAgent: "test-agent", capturedAt: 1700000000000 },
};

describe("POST /v1/timeline", () => {
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(timelines);
    await db.delete(projects);
  });

  it("returns 401 when the X-Repro-Key header is missing", async () => {
    const app = buildApp(getTestDb());
    const response = await app.inject({ method: "POST", url: "/v1/timeline", payload: validPayload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Missing X-Repro-Key header" });
  });

  it("returns 401 when the api key doesn't match any project", async () => {
    const app = buildApp(getTestDb());
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
    await db.insert(projects).values({ name: "acme", apiKey: "key-valid" });
    const app = buildApp(db);

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: { sessionId: "session-1" }, // missing reason/events/meta
    });

    expect(response.statusCode).toBe(400);
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
  });

  it("returns 401 for an unknown api key even with a malformed body, proving auth runs before validation", async () => {
    const app = buildApp(getTestDb());
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
    const [project] = await db.insert(projects).values({ name: "acme", apiKey: "key-valid" }).returning();
    const app = buildApp(db);

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
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
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/routes/timeline.test.ts` (from `server/`)
Expected: FAIL — every request returns 404 (route doesn't exist yet).

- [x] **Step 3: Write the implementation**

`server/src/routes/timeline.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TimelinePayload } from "@repro/js";
import type { Database } from "../db/client";
import type { Project } from "../db/schema";
import { findProjectByApiKey } from "../db/projects";
import { timelines } from "../db/schema";

declare module "fastify" {
  interface FastifyRequest {
    project?: Project;
  }
}

const timelineEventSchema = {
  type: "object",
  required: ["timestamp", "type", "name"],
  properties: {
    timestamp: { type: "number" },
    type: { type: "string", enum: ["custom", "error", "unhandledrejection", "trace"] },
    name: { type: "string" },
    data: { type: "object" },
  },
  additionalProperties: false,
} as const;

const timelineReasonSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["error", "unhandledrejection", "manual"] },
    message: { type: "string" },
    name: { type: "string" },
    data: { type: "object" },
  },
  additionalProperties: false,
} as const;

const timelineMetaSchema = {
  type: "object",
  required: ["url", "userAgent", "capturedAt"],
  properties: {
    url: { type: "string" },
    userAgent: { type: "string" },
    capturedAt: { type: "number" },
  },
  additionalProperties: false,
} as const;

const timelinePayloadSchema = {
  type: "object",
  required: ["sessionId", "reason", "events", "meta"],
  properties: {
    sessionId: { type: "string" },
    reason: timelineReasonSchema,
    events: { type: "array", items: timelineEventSchema },
    meta: timelineMetaSchema,
  },
  additionalProperties: false,
} as const;

export function registerTimelineRoute(app: FastifyInstance, db: Database): void {
  app.post<{ Body: TimelinePayload }>(
    "/v1/timeline",
    {
      schema: { body: timelinePayloadSchema },
      preValidation: async (request: FastifyRequest, reply) => {
        const apiKey = request.headers["x-repro-key"];
        if (typeof apiKey !== "string") {
          return reply.code(401).send({ error: "Missing X-Repro-Key header" });
        }
        const project = await findProjectByApiKey(db, apiKey);
        if (!project) {
          return reply.code(401).send({ error: "Invalid API key" });
        }
        request.project = project;
      },
    },
    async (request, reply) => {
      const project = request.project as Project;
      const [row] = await db
        .insert(timelines)
        .values({
          projectId: project.id,
          sessionId: request.body.sessionId,
          reasonType: request.body.reason.type,
          reason: request.body.reason,
          events: request.body.events,
          meta: request.body.meta,
        })
        .returning({ id: timelines.id });

      return reply.code(201).send({ id: row.id });
    }
  );
}
```

Modify `server/src/app.ts` — replace the `void db;` placeholder line with a real registration:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/client";
import { registerTimelineRoute } from "./routes/timeline";

export function buildApp(db: Database): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerTimelineRoute(app, db);

  return app;
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npm test -w server`
Expected: PASS — all tests, including the 5 new ones. Pay particular attention to the "returns 401 for an unknown api key even with a malformed body" test — this is the one that actually proves the `preValidation` ordering fix works; if it were failing before this implementation and now passes, that's direct evidence the ordering constraint is satisfied.

- [x] **Step 5: Commit**

```bash
git add server/src/routes/timeline.ts server/src/routes/timeline.test.ts server/src/app.ts
git commit -m "feat(server): add POST /v1/timeline ingest route"
```

---

### Task 8: Rate limiting

**Files:**
- Modify: `server/package.json` (add `@fastify/rate-limit` dep)
- Modify: `server/src/app.ts` (registers the plugin, `global: false`)
- Modify: `server/src/routes/timeline.ts` (opts the route into rate limiting, keyed by project id)
- Test: `server/src/routes/timeline.test.ts` (append new cases)

**Interfaces:**
- Consumes: `buildApp`, `registerTimelineRoute` (Task 6, Task 7).
- Produces: a `429 Too Many Responses` response once a project exceeds `RATE_LIMIT_MAX` requests within `RATE_LIMIT_WINDOW`.

- [x] **Step 1: Add the dependency**

Modify `server/package.json` — add to `"dependencies"`:
```json
    "@fastify/rate-limit": "^10.0.0"
```

Run: `npm install` (from repo root)

- [x] **Step 2: Write the failing test**

Append to `server/src/routes/timeline.test.ts`:
```ts
describe("POST /v1/timeline rate limiting", () => {
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(timelines);
    await db.delete(projects);
  });

  it("returns 429 after exceeding the per-project limit", async () => {
    const db = getTestDb();
    await db.insert(projects).values({ name: "acme", apiKey: "key-valid" });
    const app = buildApp(db, { rateLimitMax: 2, rateLimitWindow: "1 minute" });

    const first = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: validPayload,
    });
    const third = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: validPayload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
  });
});
```

Also modify the existing test file's other `buildApp(db)` / `buildApp(getTestDb())` calls in this same file to pass a permissive rate limit config, so the earlier tests in this file aren't affected by a default that's too strict for a test making several requests: change every existing `buildApp(db)` and `buildApp(getTestDb())` call in `server/src/routes/timeline.test.ts` (from Task 7) to `buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" })` / `buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" })`.

- [x] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/routes/timeline.test.ts` (from `server/`)
Expected: FAIL — `buildApp` doesn't accept a second argument yet (type error / runtime ignores it, and the 429 case never triggers because there's no rate limiting yet — third request also returns 201).

- [x] **Step 4: Write the implementation**

Modify `server/src/app.ts`. This is also the right point to make `bodyLimit` and the log level configurable (Task 6 hardcoded both) — `AppOptions` becomes the one place all of the spec's per-request-server config knobs live, so index.ts can wire every one of them from an env var in one place rather than some being hardcoded and others not:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Database } from "./db/client";
import { registerTimelineRoute } from "./routes/timeline";

export interface AppOptions {
  rateLimitMax?: number;
  rateLimitWindow?: string;
  bodyLimit?: number;
  logLevel?: string;
}

export async function buildApp(db: Database, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" },
    bodyLimit: options.bodyLimit ?? 256 * 1024,
  });

  await app.register(rateLimit, { global: false });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerTimelineRoute(app, db, {
    rateLimitMax: options.rateLimitMax ?? 100,
    rateLimitWindow: options.rateLimitWindow ?? "1 minute",
  });

  return app;
}
```

**Note this changes `buildApp` from synchronous to `async`** (`@fastify/rate-limit` registration is asynchronous) — every call site needs an `await` added, with no exceptions: every `buildApp(...)` call in `server/src/app.test.ts`, every pre-existing call in `server/src/routes/timeline.test.ts` from Task 7, AND the new rate-limiting test's `const app = buildApp(db, { rateLimitMax: 2, rateLimitWindow: "1 minute" });` from Step 2 above all become `await buildApp(...)`. Every enclosing `it(...)` callback is already `async` (they all are, from earlier tasks), so adding `await` needs no other change.

Modify `server/src/index.ts`'s `const app = buildApp(db);` line to read all four new env vars and pass them through:
```ts
  const app = await buildApp(db, {
    rateLimitMax: process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : undefined,
    rateLimitWindow: process.env.RATE_LIMIT_WINDOW,
    bodyLimit: process.env.BODY_LIMIT_BYTES ? Number(process.env.BODY_LIMIT_BYTES) : undefined,
    logLevel: process.env.LOG_LEVEL,
  });
```
(Each falls back to `AppOptions`'s own defaults above when the env var is unset — passing `undefined` explicitly for an unset var is fine since `options.rateLimitMax ?? 100` etc. treat `undefined` the same as an omitted key.)

Modify `server/src/routes/timeline.ts` — add a third parameter and wire the rate-limit config onto the route:
```ts
export interface TimelineRouteOptions {
  rateLimitMax: number;
  rateLimitWindow: string;
}

export function registerTimelineRoute(app: FastifyInstance, db: Database, options: TimelineRouteOptions): void {
  app.post<{ Body: TimelinePayload }>(
    "/v1/timeline",
    {
      schema: { body: timelinePayloadSchema },
      preValidation: async (request: FastifyRequest, reply) => {
        const apiKey = request.headers["x-repro-key"];
        if (typeof apiKey !== "string") {
          return reply.code(401).send({ error: "Missing X-Repro-Key header" });
        }
        const project = await findProjectByApiKey(db, apiKey);
        if (!project) {
          return reply.code(401).send({ error: "Invalid API key" });
        }
        request.project = project;
      },
      config: {
        rateLimit: {
          max: options.rateLimitMax,
          timeWindow: options.rateLimitWindow,
          hook: "preHandler",
          keyGenerator: (request: FastifyRequest) => (request.project as Project).id,
        },
      },
    },
    async (request, reply) => {
      const project = request.project as Project;
      const [row] = await db
        .insert(timelines)
        .values({
          projectId: project.id,
          sessionId: request.body.sessionId,
          reasonType: request.body.reason.type,
          reason: request.body.reason,
          events: request.body.events,
          meta: request.body.meta,
        })
        .returning({ id: timelines.id });

      return reply.code(201).send({ id: row.id });
    }
  );
}
```

Only the function signature, the `preValidation` hook's surrounding `config` block, and the new `TimelineRouteOptions` type are new here — the handler body itself is byte-for-byte what Task 7 wrote.

The `config.rateLimit.hook: "preHandler"` is what makes this work correctly: `@fastify/rate-limit`'s default hook point (`onRequest`) runs *before* `preValidation`, which would mean `request.project` isn't set yet when the rate limiter's `keyGenerator` runs. Overriding to `"preHandler"` — which Fastify runs after `preValidation` and after schema validation — guarantees `request.project` is already populated by the time the rate limiter needs it.

- [x] **Step 5: Run it to verify it passes**

Run: `npm test -w server`
Expected: PASS — all tests, including the new 429 case.

- [x] **Step 6: Commit**

```bash
git add server/package.json package-lock.json server/src/app.ts server/src/routes/timeline.ts server/src/routes/timeline.test.ts server/src/app.test.ts server/src/index.ts
git commit -m "feat(server): add per-project rate limiting to the ingest route"
```

---

### Task 9: Retention cleanup job

**Files:**
- Create: `server/src/retention.ts`
- Modify: `server/src/index.ts` (schedules the job on startup)
- Test: `server/src/retention.test.ts`

**Interfaces:**
- Consumes: `Database`, `timelines` table (Task 3), `getTestDb` (Task 4).
- Produces: `cleanupOldTimelines(db: Database, retentionDays: number): Promise<number>` (returns count deleted), `scheduleCleanup(db: Database, retentionDays: number, intervalMs?: number): NodeJS.Timeout`.

- [x] **Step 1: Write the failing test**

`server/src/retention.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb } from "../test/db";
import { projects, timelines } from "./db/schema";
import { cleanupOldTimelines } from "./retention";

describe("cleanupOldTimelines", () => {
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(timelines);
    await db.delete(projects);
  });

  it("deletes timelines older than the retention window and keeps recent ones", async () => {
    const db = getTestDb();
    const [project] = await db.insert(projects).values({ name: "acme", apiKey: "key-1" }).returning();

    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    await db.insert(timelines).values([
      {
        projectId: project.id,
        sessionId: "old-session",
        reasonType: "manual",
        reason: { type: "manual" },
        events: [],
        meta: { url: "https://example.com", userAgent: "test", capturedAt: old.getTime() },
        receivedAt: old,
      },
      {
        projectId: project.id,
        sessionId: "recent-session",
        reasonType: "manual",
        reason: { type: "manual" },
        events: [],
        meta: { url: "https://example.com", userAgent: "test", capturedAt: recent.getTime() },
        receivedAt: recent,
      },
    ]);

    const deletedCount = await cleanupOldTimelines(db, 30);

    expect(deletedCount).toBe(1);
    const remaining = await db.select().from(timelines);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe("recent-session");
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/retention.test.ts` (from `server/`)
Expected: FAIL — cannot find module `./retention`.

- [x] **Step 3: Write the implementation**

`server/src/retention.ts`:
```ts
import { lt } from "drizzle-orm";
import type { Database } from "./db/client";
import { timelines } from "./db/schema";

export async function cleanupOldTimelines(db: Database, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(timelines).where(lt(timelines.receivedAt, cutoff)).returning({ id: timelines.id });
  return deleted.length;
}

export function scheduleCleanup(
  db: Database,
  retentionDays: number,
  intervalMs: number = 24 * 60 * 60 * 1000
): NodeJS.Timeout {
  return setInterval(() => {
    cleanupOldTimelines(db, retentionDays).catch((error: unknown) => {
      console.error("[repro-server] cleanup job failed:", error);
    });
  }, intervalMs);
}
```

Modify `server/src/index.ts` — schedule the job after the app starts listening:
```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "./db/client";
import { buildApp } from "./app";
import { scheduleCleanup } from "./retention";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const migrationPool = new Pool({ connectionString: databaseUrl });
  await migrate(drizzle(migrationPool), { migrationsFolder: "./drizzle" });
  await migrationPool.end();

  const db = createDb(databaseUrl);
  const app = await buildApp(db, {
    rateLimitMax: process.env.RATE_LIMIT_MAX ? Number(process.env.RATE_LIMIT_MAX) : undefined,
    rateLimitWindow: process.env.RATE_LIMIT_WINDOW,
    bodyLimit: process.env.BODY_LIMIT_BYTES ? Number(process.env.BODY_LIMIT_BYTES) : undefined,
    logLevel: process.env.LOG_LEVEL,
  });

  const retentionDays = process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : 30;
  scheduleCleanup(db, retentionDays);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error("[repro-server] failed to start:", error);
  process.exit(1);
});
```

- [x] **Step 4: Run it to verify it passes**

Run: `npm test -w server`
Expected: PASS — all tests.

Run: `npm run typecheck -w server && npm run build -w server && npm run lint -w server`
Expected: all clean.

- [x] **Step 5: Commit**

```bash
git add server/src/retention.ts server/src/retention.test.ts server/src/index.ts
git commit -m "feat(server): add fixed-TTL retention cleanup job"
```

---

### Task 10: Dockerfile and docker-compose

**Files:**
- Create: `server/Dockerfile`
- Create: `docker-compose.yml` (root)

**Interfaces:**
- Consumes: the whole `server/` and `packages/js/` workspaces (built inside the image).
- Produces: a runnable container image for the server, and a `docker-compose.yml` bringing up server + Postgres together.

- [x] **Step 1: Write the Dockerfile**

`server/Dockerfile` (built with the repo root as context — see Step 3):
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/js/package.json packages/js/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY packages/js packages/js
COPY server server
RUN npm run build -w packages/js
RUN npm run build -w server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/js/dist packages/js/dist
COPY --from=build /app/packages/js/package.json packages/js/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/server/package.json server/package.json
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
```

Note `server/drizzle` (the migration SQL files) is copied into the runtime image — `server/dist/index.js` runs `migrate()` against `./drizzle` on startup (relative to the process's working directory, `/app`), so the runtime image needs those files, not just the compiled JS.

Modify `server/src/index.ts`'s migration call to use a path resolved relative to the compiled file's own location rather than the process's working directory, so it works correctly regardless of where the process is launched from (both `npm run start -w server` from the repo root and the Docker `CMD` above):
```ts
import path from "node:path";

// ... inside main(), replace the migrate() call's migrationsFolder:
await migrate(drizzle(migrationPool), {
  migrationsFolder: path.join(__dirname, "..", "drizzle"),
});
```

- [x] **Step 2: Write docker-compose.yml**

`docker-compose.yml` (repo root):
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: repro
      POSTGRES_PASSWORD: repro
      POSTGRES_DB: repro
    ports:
      - "5432:5432"
    volumes:
      - repro-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U repro"]
      interval: 5s
      timeout: 5s
      retries: 5

  server:
    build:
      context: .
      dockerfile: server/Dockerfile
    environment:
      DATABASE_URL: postgres://repro:repro@postgres:5432/repro
      PORT: "3000"
      RETENTION_DAYS: "30"
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  repro-postgres-data:
```

- [x] **Step 3: Verify the image builds**

Run (from repo root): `docker build -f server/Dockerfile -t repro-server .`
Expected: builds successfully through both stages.

- [x] **Step 4: Verify the server workspace still passes after the `index.ts` path change**

Run: `npm test -w server && npm run build -w server && npm run typecheck -w server`
Expected: all pass (the `migrationsFolder` path change doesn't affect the test suite, which uses `test/globalSetup.ts`'s own `migrationsFolder: "./drizzle"` relative to `server/`, unchanged).

- [x] **Step 5: Commit**

```bash
git add server/Dockerfile server/src/index.ts docker-compose.yml
git commit -m "feat(server): add Dockerfile and docker-compose for self-host/local dev"
```

---

### Task 11: Root workspace verification and end-to-end docker-compose smoke test

**Files:**
- No new source files — this task verifies the whole monorepo together.

**Interfaces:**
- Consumes: everything built in Tasks 1–10.

- [x] **Step 1: Full workspace verification**

Run (from repo root): `npm run build && npm test && npm run lint && npm run typecheck`
Expected: all four succeed across both `packages/js` and `server`.

- [x] **Step 2: End-to-end docker-compose smoke test**

Run: `docker compose up -d --build`
Wait for both containers to report healthy/running (`docker compose ps`).

Run: `curl -s http://localhost:3000/health`
Expected: `{"status":"ok"}`.

Seed a test project directly against the running Postgres container:
```bash
docker compose exec postgres psql -U repro -d repro -c \
  "INSERT INTO projects (name, api_key) VALUES ('smoke-test', 'smoke-test-key');"
```

Run:
```bash
curl -s -X POST http://localhost:3000/v1/timeline \
  -H "Content-Type: application/json" \
  -H "X-Repro-Key: smoke-test-key" \
  -d '{"sessionId":"smoke-session","reason":{"type":"manual","name":"smoke-test"},"events":[],"meta":{"url":"https://example.com","userAgent":"curl","capturedAt":1700000000000}}'
```
Expected: `201` status with a JSON body containing an `id`.

Run: `docker compose exec postgres psql -U repro -d repro -c "SELECT session_id, reason_type FROM timelines;"`
Expected: one row, `smoke-session` / `manual`.

Run: `docker compose down -v`
Expected: containers stop and the volume is removed (clean teardown, no leftover state for future runs).

- [x] **Step 3: Commit**

If Step 1 or Step 2 required any fixes, commit them now with an appropriate message. If everything passed with no changes needed, there's nothing to commit for this task — note that in the report instead.
