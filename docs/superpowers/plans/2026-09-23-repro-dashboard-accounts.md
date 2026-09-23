# repro Dashboard (4a): Accounts, Orgs & Self-Serve Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user accounts (email/password plus optional GitHub OAuth), orgs with owner/member roles and link invites, org ownership of projects, and a React dashboard where members create projects and mint and revoke API keys, all served by the existing single Fastify container.

**Architecture:** The server grows in three layers.
- **Service layer:** pure primitives in `server/src/auth/` (scrypt passwords, random tokens) and DB service modules in `server/src/db/` (`users`, `sessions`, `orgs`, `invites`, plus the existing `projects`). They take an `Executor` (a database *or* an open transaction), so `server/src/accounts.ts` can compose multi-step flows (signup, accepting an invite) in one transaction.
- **HTTP layer:** cookie-session auth with an `Origin`-based CSRF guard on `/api/*`. CORS is scoped to `/v1/*` only. Every org-scoped route sits behind `requireUser` + `requireMembership` preValidation hooks.
- **Frontend:** a new `dashboard/` workspace (Vite + React 18 + React Router 7 + TanStack Query 5 + Tailwind v4) builds to static files that Fastify serves at `/` with an SPA fallback.

**Tech Stack:** TypeScript, Fastify 5 (`@fastify/cookie`, `@fastify/static`, `@fastify/cors`, `@fastify/rate-limit`), Drizzle ORM 0.36 + drizzle-kit 0.28, `pg`, `node:crypto` (scrypt, SHA-256), Vitest 2 + testcontainers, React 18, React Router 7, TanStack Query 5, Tailwind CSS 4, Testing Library, Docker.

**Spec:** `docs/superpowers/specs/2026-09-23-repro-dashboard-accounts-design.md`

## Global Constraints

- Roles are exactly `owner` and `member`, stored as `text` (no Postgres enum). Members can do everything except manage people (invites, role changes, removing others) and rename the org.
- Every org keeps at least one owner. Violations return `409 { error: "An org must have at least one owner" }`.
- A non-member (or a nonexistent / non-UUID org id) gets `404 { error: "Not Found" }` on every `/api/orgs/:orgId/...` route. A member lacking the owner role gets `403 { error: "Forbidden" }`. Nested resources (project, key, invite, member) are always looked up together with their `org_id`.
- Tenant ids come only from the URL, never from a request body.
- Passwords: 8–256 characters, no composition rules. Hash format `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>` with N=2^15, r=8, p=1, 16-byte salt, 64-byte output, verified with `crypto.timingSafeEqual`. No bcrypt/argon2 dependency.
- Emails are stored trimmed and lowercased, max 254 characters, and must match `/^[^\s@]+@[^\s@]+$/`. Names (user, org, project) are 1–100 characters after trimming.
- Session cookie is `repro_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `PUBLIC_URL` is https. It holds a token of 32 random bytes (base64url); only its SHA-256 is stored. Sessions have a fixed 30-day expiry and no sliding.
- Invite tokens are `rpi_` + base64url of 32 random bytes, single-use, valid for 7 days, and not bound to an email. The link is `${PUBLIC_URL}/invite/<token>`, shown once. A used, revoked or expired token all give `404 { error: "Invite not found or expired" }`.
- `SIGNUP` is `open` or `invite-only` (default `invite-only`). Bootstrap (empty `users` table) is always allowed and serialized by an advisory lock. Bootstrap makes the user owner of every memberless org, or of a new personal org if there are none. Open signup creates a personal org named `<name>'s org`. An invite signup joins the invite's org and gets no personal org.
- GitHub is never auto-linked by email. A GitHub login whose email matches an existing account is refused with `github_email_exists`.
- **CSRF** (clarifies the spec): every non-GET/HEAD/OPTIONS `/api/*` request must carry an `Origin` equal to `PUBLIC_URL`'s origin. When it has a `Content-Type`, that type must be `application/json`. Otherwise the response is `403`. Body-less POSTs and DELETEs send no `Content-Type`, because Fastify rejects an empty body declared as JSON. The SPA sets `Content-Type` only when it sends a body.
- `/api/*` has no CORS headers. The existing permissive CORS applies only to `/v1/*`.
- **GitHub callback** (clarifies the spec): it always ends in a redirect, never JSON. Login-intent failures go to `/login?error=<code>`. Connect-intent results go to `/settings` or `/settings?error=<code>`.
- Error bodies use the same `{ error: "message" }` envelope as ingest. 5xx never leaks internals.
- No email sending, no org/project/user deletion, no `last_used_at`, no OAuth provider other than GitHub, no instance-admin UI.
- `repro-admin` remains `node:util` `parseArgs` with the exit codes `0` success, `1` not found / unexpected, `2` usage / argument errors.
- Existing test conventions: Vitest, one shared testcontainers Postgres, test files run serially, every test file resets the DB in `beforeEach`.
- **Dashboard React version:** the dashboard uses **React 18.3**, the same major as `packages/js`. npm hoists one `react` to the repo root, and a second major would give `@testing-library/react` a different React copy from the one the app renders with.
- **Toolchain versions:** Vite 5 and Vitest 2, matching the versions already hoisted at the repo root. `@vitejs/plugin-react` ^4 because v5+ requires Vite 8.

## Review Focus

The spec implies these five cases, but no single feature test naturally covers them. Each one has a pinned test in the task named.

1. **Email case and whitespace:** signing up as `"  Ana@Example.COM "` stores `ana@example.com`. Logging in as `ana@example.com` works, and signing up again with a different case is `409`. (Task 7)
2. **A member removed mid-session:** their next request to any route of that org is `404`, with no stale access from a cached membership. (Task 8)
3. **A key id from another project in the same org:** revoking through `/api/orgs/A/projects/P1/keys/<P2's key>/revoke` is `404`, and the key stays active. (Task 9)
4. **Whitespace-only names:** creating an org or project named `"   "` is `400` with a readable message, not a blank row. (Tasks 8 and 9)
5. **Password login for a GitHub-only account:** it gets the same generic `401 Invalid email or password`, and doesn't crash on a `NULL` password hash. (Task 7)

## Prerequisites

From the repo root, once: `npm install`. Docker must be running, because all server tests share a testcontainers Postgres (`server/test/globalSetup.ts`).

Run server tests with `npm test -w server` (or a single file: `npm test -w server -- src/auth/password.test.ts`). Run dashboard tests with `npm test -w dashboard`.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `server/src/auth/password.ts` | create | scrypt `hashPassword`, `verifyPassword`, `verifyPasswordOrDummy` |
| `server/src/auth/tokens.ts` | create | `generateToken`, `hashToken`, `generatePassword` |
| `server/src/auth/http.ts` | create | cookie names, `startSession`, `clearSessionCookie`, `csrfGuard`, `requireUser`, `requireMembership`, request type augmentation |
| `server/src/auth/github.ts` | create | GitHub authorize URL, token exchange, profile + verified primary email |
| `server/src/db/client.ts` | modify | add `Executor` type |
| `server/src/db/schema.ts` | modify | `users`, `sessions`, `orgs`, `memberships`, `invites`; `projects.orgId`; `Role` |
| `server/drizzle/0002_*.sql` + `meta/*` | generate + hand-edit | migration incl. `Default` org backfill |
| `server/src/db/orgs.ts` | create | orgs, memberships, last-owner rule |
| `server/src/db/users.ts` | create | user lookups/inserts, `normalizeEmail` |
| `server/src/db/sessions.ts` | create | session create/find/delete/expire |
| `server/src/db/invites.ts` | create | invite create/list/revoke/find/consume |
| `server/src/db/projects.ts` | modify | org-aware `createProject`/`listProjects`; `findProjectInOrg`, `findApiKeyInOrg` |
| `server/src/accounts.ts` | create | `signUp`, `acceptInvite` (multi-step transactions); `SignupMode` |
| `server/src/config.ts` | create | `loadDashboardConfig(env)`; `GithubConfig` |
| `server/src/uuid.ts` | create | shared `isUuid` (moved from `admin.ts`) |
| `server/src/rate-limit.ts` | create | shared `rateLimitErrorBody` (moved from `routes/timeline.ts`) |
| `server/src/routes/context.ts` | create | `ApiContext` passed to every `/api` route module |
| `server/src/routes/errors.ts` | create | `httpError`, `requireName` |
| `server/src/routes/auth.ts` | create | `/api/auth/config`, `signup`, `login`, `logout` |
| `server/src/routes/me.ts` | create | `/api/me`, password change, GitHub disconnect; `meBody` |
| `server/src/routes/orgs.ts` | create | orgs, members, invites (owner side) |
| `server/src/routes/invites.ts` | create | public invite preview + accept |
| `server/src/routes/projects.ts` | create | projects and keys |
| `server/src/routes/github.ts` | create | OAuth start + callback |
| `server/src/routes/timeline.ts` | modify | path `/timeline` under the `/v1` prefix; shared rate-limit body |
| `server/src/app.ts` | modify | new options, cookie plugin, scoped CORS, CSRF, route modules, SPA serving |
| `server/src/index.ts` | modify | read new env via `loadDashboardConfig` |
| `server/src/admin.ts` | modify | `org list`, `project create --org`, `project list` org column, `user reset-password` |
| `server/src/retention.ts` | modify | also delete expired sessions |
| `server/test/db.ts` | modify | reset new tables; `createTestOrg`, `createTestUser`, `sessionCookie` |
| `server/test/http.ts` | create | `buildTestApp`, `call`, `TEST_ORIGIN` |
| `server/package.json` | modify | add `@fastify/cookie`, `@fastify/static` |
| `server/Dockerfile`, `docker-compose.yml` | modify | build + ship the dashboard; `PUBLIC_URL` |
| `dashboard/**` | create | the SPA workspace |
| `package.json` (root) | modify | add `dashboard` workspace |
| `server/README.md`, `README.md`, specs | modify | docs |

Test files sit next to their modules (`*.test.ts`) as today.

---

### Task 1: Password and token primitives

**Files:**
- Create: `server/src/auth/password.ts`, `server/src/auth/tokens.ts`
- Test: `server/src/auth/password.test.ts`, `server/src/auth/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `hashPassword(password: string): Promise<string>`
  - `verifyPassword(password: string, stored: string): Promise<boolean>`
  - `verifyPasswordOrDummy(password: string, stored: string | null): Promise<boolean>`: always does one scrypt verification, and returns `false` when `stored` is `null`.
  - `interface GeneratedToken { token: string; hash: string }`
  - `generateToken(prefix?: string): GeneratedToken`: `prefix` + base64url(32 random bytes).
  - `hashToken(token: string): string`: SHA-256 as lowercase hex.
  - `generatePassword(): string`: 24 base64url characters.

- [x] **Step 1: Write the failing tests**

Create `server/src/auth/password.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from "./password";

describe("hashPassword / verifyPassword", () => {
  it("produces a self-describing scrypt hash", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("correct horsE", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("honors the cost parameters encoded in the hash", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("pw-at-low-cost", salt, 64, { N: 1024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("pw-at-low-cost", stored)).toBe(true);
  });

  it.each([["nope"], ["bcrypt$1$2$3$4$5"], ["scrypt$x$8$1$abc$def"], ["scrypt$1024$8$1$abc$"]])(
    "returns false for a malformed hash %s",
    async (stored) => {
      expect(await verifyPassword("anything", stored)).toBe(false);
    }
  );
});

describe("verifyPasswordOrDummy", () => {
  it("returns false when there is no stored hash", async () => {
    expect(await verifyPasswordOrDummy("anything", null)).toBe(false);
  });

  it("verifies against a real hash when one is given", async () => {
    const hash = await hashPassword("secret-pw");
    expect(await verifyPasswordOrDummy("secret-pw", hash)).toBe(true);
  });
});
```

Create `server/src/auth/tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generatePassword, generateToken, hashToken } from "./tokens";

describe("generateToken", () => {
  it("returns 43 base64url characters and their SHA-256", () => {
    const { token, hash } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prepends the prefix", () => {
    expect(generateToken("rpi_").token).toMatch(/^rpi_[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", () => {
    expect(generateToken().token).not.toBe(generateToken().token);
  });
});

describe("hashToken", () => {
  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("generatePassword", () => {
  it("returns 24 base64url characters", () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/auth`
Expected: FAIL. The modules `./password` and `./tokens` cannot be resolved.

- [x] **Step 3: Implement**

Create `server/src/auth/password.ts`:

```ts
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Cost parameters are written into every hash, so they can be raised later
// without invalidating existing hashes.
const COST = { N: 2 ** 15, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// scrypt needs about 128 * N * r bytes (32 MiB at these parameters), which sits
// right at Node's default limit, so raise the limit explicitly.
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, keylen: number, cost: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC so the same password typed on different keyboards/OSes hashes the same.
    scrypt(password.normalize("NFKC"), salt, keylen, { ...cost, maxmem: MAX_MEM }, (error, key) =>
      error ? reject(error) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  const actual = await derive(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

// For callers with no hash to check (unknown email, GitHub-only user): does the
// same scrypt work as a real check, so response time doesn't reveal which case it was.
export async function verifyPasswordOrDummy(password: string, stored: string | null): Promise<boolean> {
  if (stored !== null) {
    return verifyPassword(password, stored);
  }
  dummyHash ??= hashPassword("repro-dummy-password");
  await verifyPassword(password, await dummyHash);
  return false;
}
```

Create `server/src/auth/tokens.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

export interface GeneratedToken {
  /** Plaintext — handed to the client once, never stored. */
  token: string;
  /** What gets stored. */
  hash: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// 32 random bytes: high-entropy, so a fast hash is the right choice for storage
// (same reasoning as API keys in keys.ts).
export function generateToken(prefix = ""): GeneratedToken {
  const token = prefix + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/auth`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/auth
git commit -m "feat(server): add scrypt password hashing and random token primitives"
```

---

### Task 2: Orgs own projects: schema, migration, org-aware project service, CLI

**Files:**
- Modify: `server/src/db/client.ts`, `server/src/db/schema.ts`, `server/src/db/projects.ts`, `server/src/admin.ts`, `server/test/db.ts`
- Create: `server/src/db/orgs.ts`, `server/src/uuid.ts`, `server/drizzle/0002_<generated>.sql` (+ `meta/0002_snapshot.json`, `meta/_journal.json`)
- Test: `server/src/db/orgs.test.ts` (create), `server/src/db/migrations.test.ts` (create), `server/src/db/projects.test.ts`, `server/src/db/schema.test.ts`, `server/src/admin.test.ts` (modify)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `server/src/db/client.ts`: `type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>`. A `Database` and a transaction `tx` both satisfy it.
  - `server/src/db/schema.ts`:
    - Tables `users`, `sessions`, `orgs`, `memberships`, `invites`.
    - `projects.orgId`.
    - `ROLES = ["owner", "member"] as const`, `type Role`.
    - Types `User`, `Session`, `Org`, `Membership`, `Invite`.
  - `server/src/db/orgs.ts`:
    - `createOrg(ex: Executor, name: string): Promise<Org>`
    - `findOrg(ex: Executor, orgId: string): Promise<Org | undefined>`
    - `interface OrgSummary extends Org { memberCount: number; projectCount: number }`
    - `listOrgs(ex: Executor): Promise<OrgSummary[]>`
  - `server/src/db/projects.ts`:
    - `createProject(db: Database, orgId: string, name: string)`
    - `listProjects(db: Database, filter?: { orgId?: string })`
    - `findProjectInOrg(db: Database, orgId: string, projectId: string): Promise<Project | undefined>`
    - `findApiKeyInOrg(db: Database, orgId: string, projectId: string, keyId: string): Promise<ApiKeySummary | undefined>`
    - `ProjectSummary` now includes `orgId`.
  - `server/src/uuid.ts`: `isUuid(value: string): boolean`.
  - `server/test/db.ts`:
    - `resetDb` clears the new tables.
    - `createTestOrg(db, name = "Acme"): Promise<Org>`
    - `createTestProject(db, name = "acme", orgId?: string)`, which creates an org when none is given.

- [x] **Step 1: Add the `Executor` type**

In `server/src/db/client.ts`, replace the whole file with:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

export function createDb(connectionString: string) {
  const pool = new Pool({ connectionString });
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;

/**
 * A database or an open transaction. Service functions that take an Executor can
 * run on their own or as one step of a caller's transaction.
 */
export type Executor = PgDatabase<NodePgQueryResultHKT, typeof schema>;
```

- [x] **Step 2: Extend the schema**

Replace `server/src/db/schema.ts` with:

```ts
import { pgTable, uuid, text, timestamp, jsonb, index, primaryKey } from "drizzle-orm/pg-core";

export const ROLES = ["owner", "member"] as const;
export type Role = (typeof ROLES)[number];

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Stored trimmed and lowercased — see normalizeEmail() in db/users.ts.
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  // NULL for users who only log in with GitHub. Format: see auth/password.ts.
  passwordHash: text("password_hash"),
  // GitHub's numeric user id, as text.
  githubId: text("github_id").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the cookie token. The token itself is never stored.
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Fixed at creation (30 days); not extended on use.
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => ({
    userIdx: index("sessions_user_idx").on(table.userId),
  })
);

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // Plain text, not a Postgres enum: validity is enforced in code, so a new
    // role is a code change rather than a migration.
    role: text("role").$type<Role>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.userId] }),
    userIdx: index("memberships_user_idx").on(table.userId),
  })
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    // SHA-256 of the rpi_ token. The token is shown once, at creation.
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role").$type<Role>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    orgIdx: index("invites_org_idx").on(table.orgId),
  })
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("projects_org_idx").on(table.orgId),
  })
);

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

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Timeline = typeof timelines.$inferSelect;
```

- [x] **Step 3: Generate the migration**

Run (from `server/`): `npx drizzle-kit generate`
Expected: new `drizzle/0002_<random_name>.sql`, `drizzle/meta/0002_snapshot.json`, updated `drizzle/meta/_journal.json`. No live database is needed. If drizzle-kit asks about a rename, every table and column is **new** (create, don't rename).

Open the generated SQL and confirm that it contains `CREATE TABLE` statements for `users`, `sessions`, `orgs`, `memberships` and `invites`, and the line:

```sql
ALTER TABLE "projects" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
```

- [x] **Step 4: Hand-edit the migration to backfill existing projects**

A `NOT NULL` column can't be added to a table that already has rows. In `drizzle/0002_*.sql`, replace that single `ADD COLUMN` line with the block below. Put it **after** every `CREATE TABLE` statement (drizzle-kit normally emits the creates first; if the `ALTER` came earlier, move it). Keep the generated FK `DO $$ ... $$` block and `CREATE INDEX` statements unchanged.

```sql
ALTER TABLE "projects" ADD COLUMN "org_id" uuid;--> statement-breakpoint
-- Projects created before orgs existed are moved into one "Default" org, which the
-- first user to sign up takes ownership of (see accounts.ts signUp bootstrap).
INSERT INTO "orgs" ("name") SELECT 'Default' WHERE EXISTS (SELECT 1 FROM "projects");--> statement-breakpoint
UPDATE "projects" SET "org_id" = (SELECT "id" FROM "orgs" WHERE "name" = 'Default' LIMIT 1) WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
```

Do not touch `meta/0002_snapshot.json`: the final schema is identical, and only the path to it differs.

- [x] **Step 5: Write the migration test**

Create `server/src/db/migrations.test.ts`:

```ts
import { describe, it, expect, inject } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const MIGRATIONS = path.join(__dirname, "..", "..", "drizzle");

// A copy of the migrations folder whose journal stops before the org migration (idx 2).
function migrationsBeforeOrgs(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repro-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < 2);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

// Runs `fn` against a brand-new database in the shared test container, so the
// migrations can be applied from scratch without disturbing other tests.
async function withFreshDatabase(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const adminUrl = inject("databaseUrl");
  const name = `migration_test_${Date.now()}`;
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}

describe("org migration (0002)", () => {
  it("moves projects that existed before orgs into a single Default org", async () => {
    await withFreshDatabase(async (pool) => {
      const db = drizzle(pool);
      const before = migrationsBeforeOrgs();
      try {
        await migrate(db, { migrationsFolder: before });
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      await pool.query(`INSERT INTO projects (name) VALUES ('legacy-a'), ('legacy-b')`);

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const orgs = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM orgs`);
      expect(orgs.rows).toHaveLength(1);
      expect(orgs.rows[0].name).toBe("Default");
      const projects = await pool.query<{ org_id: string }>(`SELECT org_id FROM projects ORDER BY name`);
      expect(projects.rows.map((row) => row.org_id)).toEqual([orgs.rows[0].id, orgs.rows[0].id]);
    });
  });

  it("creates no org on an empty database and leaves projects.org_id NOT NULL", async () => {
    await withFreshDatabase(async (pool) => {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

      const orgs = await pool.query(`SELECT 1 FROM orgs`);
      expect(orgs.rows).toHaveLength(0);
      const column = await pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'org_id'`
      );
      expect(column.rows[0].is_nullable).toBe("NO");
    });
  });
});
```

- [x] **Step 6: Run the migration test**

Run: `npm test -w server -- src/db/migrations.test.ts`
Expected: PASS (2 tests). The test only needs the SQL files, not the service code. If the first test fails with `column "org_id" ... contains null values`, the backfill block is in the wrong position (Step 4).

- [x] **Step 7: Write the failing service tests**

Create `server/src/db/orgs.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestOrg, createTestProject, createTestUserRow, getTestDb, resetDb } from "../../test/db";
import { memberships } from "./schema";
import { createOrg, findOrg, listOrgs } from "./orgs";

describe("orgs", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates and finds an org", async () => {
    const db = getTestDb();
    const org = await createOrg(db, "Acme");
    expect(org.name).toBe("Acme");
    expect((await findOrg(db, org.id))?.id).toBe(org.id);
    expect(await findOrg(db, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("lists orgs oldest first with member and project counts", async () => {
    const db = getTestDb();
    const acme = await createTestOrg(db, "Acme");
    const empty = await createTestOrg(db, "Empty");
    await createTestProject(db, "web", acme.id);
    await createTestProject(db, "api", acme.id);
    const user = await createTestUserRow(db);
    await db.insert(memberships).values({ orgId: acme.id, userId: user.id, role: "owner" });

    const result = await listOrgs(db);

    expect(result.map((o) => [o.id, o.name, o.memberCount, o.projectCount])).toEqual([
      [acme.id, "Acme", 1, 2],
      [empty.id, "Empty", 0, 0],
    ]);
  });
});
```

`createTestUserRow` is a minimal user insert used here, before Task 3 adds the real `createTestUser`. Add it to `server/test/db.ts` in Step 9.

In `server/src/db/projects.test.ts`, make these edits:

1. Change the import line from `../../test/db` to also import `createTestOrg`:
   `import { createTestOrg, createTestProject, getTestDb, resetDb } from "../../test/db";`
   Add `findApiKeyInOrg, findProjectInOrg` to the `./projects` import list.
2. Replace the whole `describe("createProject", ...)` block with:

```ts
describe("createProject", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates the project in the org and returns a plaintext rpk_ key", async () => {
    const db = getTestDb();
    const org = await createTestOrg(db);
    const { project, key } = await createProject(db, org.id, "widgets-inc");

    expect(project.name).toBe("widgets-inc");
    expect(project.orgId).toBe(org.id);
    expect(key).toMatch(/^rpk_[A-Za-z0-9_-]{43}$/);
  });

  it("stores only the hash and display prefix, never the plaintext key", async () => {
    const db = getTestDb();
    const org = await createTestOrg(db);
    const { project, key } = await createProject(db, org.id, "widgets-inc");

    const rows = await db.select().from(apiKeys).where(eq(apiKeys.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].keyHash).toBe(hashApiKey(key));
    expect(rows[0].prefix).toBe(key.slice(0, 12));
    expect(rows[0].revokedAt).toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(key);
  });

  it("allows two projects with the same name", async () => {
    const db = getTestDb();
    const org = await createTestOrg(db);
    const first = await createProject(db, org.id, "web");
    const second = await createProject(db, org.id, "web");
    expect(first.project.id).not.toBe(second.project.id);
  });
});
```

3. In the test `"reports zero active keys for a project that never had a key (pre-upgrade project)"`, replace its body with:

```ts
    const db = getTestDb();
    const org = await createTestOrg(db);
    const [legacy] = await db.insert(projects).values({ name: "legacy", orgId: org.id }).returning();

    const result = await listProjects(db);

    expect(result).toEqual([
      { id: legacy.id, orgId: org.id, name: "legacy", createdAt: legacy.createdAt, activeKeyCount: 0 },
    ]);
```

4. Append at the end of the file:

```ts
describe("org scoping", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("listProjects filters by org when asked", async () => {
    const db = getTestDb();
    const { project: mine } = await createTestProject(db, "mine");
    await createTestProject(db, "theirs");

    const result = await listProjects(db, { orgId: mine.orgId });

    expect(result.map((p) => p.id)).toEqual([mine.id]);
    expect(await listProjects(db)).toHaveLength(2);
  });

  it("findProjectInOrg only finds a project through its own org", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const other = await createTestOrg(db, "Other");

    expect((await findProjectInOrg(db, project.orgId, project.id))?.id).toBe(project.id);
    expect(await findProjectInOrg(db, other.id, project.id)).toBeUndefined();
  });

  it("findApiKeyInOrg requires the key to belong to that project in that org", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const { project: sibling } = await createTestProject(db, "sibling", project.orgId);
    const other = await createTestOrg(db, "Other");
    const [key] = await listApiKeys(db, project.id);

    const found = await findApiKeyInOrg(db, project.orgId, project.id, key.id);
    expect(found).toEqual(key);
    expect(await findApiKeyInOrg(db, project.orgId, sibling.id, key.id)).toBeUndefined();
    expect(await findApiKeyInOrg(db, other.id, project.id, key.id)).toBeUndefined();
  });
});
```

In `server/src/db/schema.test.ts`, change the insert line to create an org first:

```ts
    const org = await createTestOrg(db);
    const [inserted] = await db.insert(projects).values({ name: "test project", orgId: org.id }).returning();
```

Then update its import to `import { createTestOrg, getTestDb, resetDb } from "../../test/db";`.

In `server/src/admin.test.ts`:

1. Import `createTestOrg` from `../test/db`.
2. In `describe("command shape errors")`, change the argv in the tests `"exits 2 with usage for a missing argument"` and `"exits 2 with usage for an extra argument"` to include an org. The expected output stays the same:
   - `run(["project", "create", "--org", MISSING_ID])` expects `["Missing argument: <name>", USAGE]`.
   - `run(["project", "create", "--org", MISSING_ID, "My", "Project"])` expects `["Unexpected argument: Project", USAGE]`.
3. Replace the test `"accepts a project name starting with '-' after --"` with:

```ts
    it("accepts a project name starting with '-' after --", async () => {
      const org = await createTestOrg(getTestDb());
      const result = await run(["project", "create", "--org", org.id, "--", "-beta"]);
      expect(result.code).toBe(0);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("-beta");
    });
```

4. Replace the whole `describe("project create", ...)` block with:

```ts
  describe("project create", () => {
    it("creates the project in the org and prints its id and a working key once", async () => {
      const org = await createTestOrg(getTestDb());
      const result = await run(["project", "create", "--org", org.id, "Acme"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toEqual([]);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("Acme");
      expect(project.orgId).toBe(org.id);
      expect(result.stdout[0]).toBe(`Created project "Acme" (${project.id})`);
      expect(result.stdout[1]).toMatch(KEY_PATTERN);
      expect(result.stdout[2]).toBe("Store this API key now. It will not be shown again.");
      expect((await findProjectByApiKey(getTestDb(), result.stdout[1]))?.id).toBe(project.id);
    });

    it("trims the project name", async () => {
      const org = await createTestOrg(getTestDb());
      await run(["project", "create", "--org", org.id, "  Acme  "]);
      const [project] = await listProjects(getTestDb());
      expect(project.name).toBe("Acme");
    });

    it("exits 2 without usage for a whitespace-only name", async () => {
      const org = await createTestOrg(getTestDb());
      const result = await run(["project", "create", "--org", org.id, "   "]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Project name is required"]);
      expect(await listProjects(getTestDb())).toEqual([]);
    });

    it("exits 2 with usage when --org is missing", async () => {
      const result = await run(["project", "create", "Acme"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Missing option: --org <orgId>", USAGE]);
    });

    it("exits 2 for a malformed org id", async () => {
      const result = await run(["project", "create", "--org", "nope", "Acme"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Invalid id: nope"]);
    });

    it("exits 1 when the org doesn't exist", async () => {
      const result = await run(["project", "create", "--org", MISSING_ID, "Acme"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual([`Org not found: ${MISSING_ID}`]);
      expect(await listProjects(getTestDb())).toEqual([]);
    });

    it("rejects --org on other commands", async () => {
      const result = await run(["project", "list", "--org", MISSING_ID]);
      expect(result.code).toBe(2);
      expect(result.stderr).toEqual(["Unknown option: --org", USAGE]);
    });
  });
```

5. In `describe("project list")`, in the table test, change the header assertion and add an org assertion:

```ts
      expect(result.stdout[0]).toMatch(/^ID\s+ORG\s+NAME\s+CREATED\s+ACTIVE KEYS$/);
      expect(result.stdout[1]).toContain(project.orgId);
```

6. Add a new block after `describe("project list")`:

```ts
  describe("org list", () => {
    it("prints a message when there are no orgs", async () => {
      const result = await run(["org", "list"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual(["No orgs."]);
    });

    it("prints orgs with member and project counts", async () => {
      const { project } = await createTestProject(getTestDb(), "web");

      const result = await run(["org", "list"]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toMatch(/^ID\s+NAME\s+CREATED\s+MEMBERS\s+PROJECTS$/);
      expect(result.stdout[1]).toContain(project.orgId);
      expect(result.stdout[1]).toMatch(/\s0\s+1$/);
    });
  });
```

- [x] **Step 8: Run the tests to verify they fail**

Run: `npm test -w server`
Expected: FAIL. `./orgs` can't be resolved, `createTestOrg` and `createTestUserRow` are missing, and `createProject`'s signature has changed.

- [x] **Step 9: Implement**

Create `server/src/uuid.ts`:

```ts
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checked before querying, so Postgres never raises a uuid cast error.
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
```

Create `server/src/db/orgs.ts`:

```ts
import { asc, eq, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { memberships, orgs, projects, type Org } from "./schema";

export interface OrgSummary extends Org {
  memberCount: number;
  projectCount: number;
}

export async function createOrg(ex: Executor, name: string): Promise<Org> {
  const [org] = await ex.insert(orgs).values({ name }).returning();
  return org;
}

export async function findOrg(ex: Executor, orgId: string): Promise<Org | undefined> {
  const [org] = await ex.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return org;
}

export async function listOrgs(ex: Executor): Promise<OrgSummary[]> {
  return ex
    .select({
      id: orgs.id,
      name: orgs.name,
      createdAt: orgs.createdAt,
      memberCount: sql<number>`(select count(*) from ${memberships} where ${memberships.orgId} = ${orgs.id})`.mapWith(
        Number
      ),
      projectCount: sql<number>`(select count(*) from ${projects} where ${projects.orgId} = ${orgs.id})`.mapWith(
        Number
      ),
    })
    .from(orgs)
    .orderBy(asc(orgs.createdAt));
}
```

In `server/src/db/projects.ts`:

1. Replace `createProject` with:

```ts
export async function createProject(db: Database, orgId: string, name: string): Promise<CreatedProject> {
  return db.transaction(async (tx) => {
    const [project] = await tx.insert(projects).values({ orgId, name }).returning();
    const generated = generateApiKey();
    await tx.insert(apiKeys).values({
      projectId: project.id,
      keyHash: generated.hash,
      prefix: generated.prefix,
    });
    return { project, key: generated.key };
  });
}
```

2. Replace `listProjects` with:

```ts
/** All projects (CLI), or one org's projects when `orgId` is given (dashboard). */
export async function listProjects(db: Database, filter: { orgId?: string } = {}): Promise<ProjectSummary[]> {
  return db
    .select({
      id: projects.id,
      orgId: projects.orgId,
      name: projects.name,
      createdAt: projects.createdAt,
      activeKeyCount: sql<number>`count(${apiKeys.id}) filter (where ${apiKeys.revokedAt} is null)`.mapWith(Number),
    })
    .from(projects)
    .leftJoin(apiKeys, eq(apiKeys.projectId, projects.id))
    .where(filter.orgId ? eq(projects.orgId, filter.orgId) : undefined)
    .groupBy(projects.id)
    .orderBy(asc(projects.createdAt));
}
```

3. Append:

```ts
// Dashboard routes look a project up through its org, so an id from another
// tenant resolves to undefined (→ 404) rather than to someone else's project.
// Callers must pass syntactically valid UUIDs.
export async function findProjectInOrg(db: Database, orgId: string, projectId: string): Promise<Project | undefined> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
    .limit(1);
  return project;
}

export async function findApiKeyInOrg(
  db: Database,
  orgId: string,
  projectId: string,
  keyId: string
): Promise<ApiKeySummary | undefined> {
  const [apiKey] = await db
    .select(apiKeySummaryColumns)
    .from(apiKeys)
    .innerJoin(projects, eq(apiKeys.projectId, projects.id))
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.projectId, projectId), eq(projects.orgId, orgId)))
    .limit(1);
  return apiKey;
}
```

Replace `server/test/db.ts` with:

```ts
import { inject } from "vitest";
import { createDb, type Database } from "../src/db/client";
import {
  apiKeys,
  invites,
  memberships,
  orgs,
  projects,
  sessions,
  timelines,
  users,
  type Org,
  type User,
} from "../src/db/schema";
import { createProject, type CreatedProject } from "../src/db/projects";
import { createOrg } from "../src/db/orgs";

// One pool per test file: Vitest isolates each file's module graph, so this is
// reset between files, and the connections close when the file's worker exits.
let testDb: Database | undefined;

export function getTestDb(): Database {
  testDb ??= createDb(inject("databaseUrl"));
  return testDb;
}

// Deletes in foreign-key order: children before the rows they reference.
export async function resetDb(db: Database): Promise<void> {
  await db.delete(timelines);
  await db.delete(apiKeys);
  await db.delete(projects);
  await db.delete(invites);
  await db.delete(sessions);
  await db.delete(memberships);
  await db.delete(orgs);
  await db.delete(users);
}

export async function createTestOrg(db: Database, name = "Acme"): Promise<Org> {
  return createOrg(db, name);
}

export async function createTestProject(db: Database, name = "acme", orgId?: string): Promise<CreatedProject> {
  return createProject(db, orgId ?? (await createTestOrg(db)).id, name);
}

let rowSeq = 0;

// Bare user row with no password. Task 3 adds createTestUser, the one tests
// normally use.
export async function createTestUserRow(db: Database): Promise<User> {
  rowSeq += 1;
  const [user] = await db
    .insert(users)
    .values({ email: `row${rowSeq}@example.com`, name: `Row ${rowSeq}` })
    .returning();
  return user;
}
```

In `server/src/admin.ts`:

1. Replace the imports and `USAGE` with:

```ts
import { parseArgs } from "node:util";
import type { Database } from "./db/client";
import { findOrg, listOrgs } from "./db/orgs";
import { createApiKey, createProject, listApiKeys, listProjects, revokeApiKey } from "./db/projects";
import { isUuid } from "./uuid";

export interface CliOutput {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const USAGE = `Usage: repro-admin <command>

Commands:
  org list                                List orgs
  project create --org <orgId> <name>     Create a project in an org, with its first API key
  project list                            List projects
  key create <projectId>                  Create an additional API key for a project
  key list <projectId>                    List a project's API keys
  key revoke <keyId>                      Revoke an API key

Put -- before an argument that starts with "-", e.g. project create --org <orgId> -- -beta`;
```

2. Delete the `UUID_PATTERN` constant, and in `parseId` replace `!UUID_PATTERN.test(value)` with `!isUuid(value)`.
3. Replace the body of `runCli`'s `try` block up to and including the `switch` with:

```ts
    const { values, positionals } = parsePositionals(argv);
    if (values.help) {
      out.stdout(USAGE);
      return 0;
    }
    const [group, action, ...rest] = positionals;
    if (!group) {
      throw new CliError("Missing command", 2, true);
    }
    const command = `${group} ${action ?? ""}`;
    if (values.org !== undefined && command !== "project create") {
      throw new CliError("Unknown option: --org", 2, true);
    }
    switch (command) {
      case "org list":
        noArgs(rest);
        return await orgList(db, out);
      case "project create": {
        if (values.org === undefined) {
          throw new CliError("Missing option: --org <orgId>", 2, true);
        }
        const orgId = parseId(values.org);
        return await projectCreate(db, out, orgId, singleArg(rest, "<name>"));
      }
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
```

4. Replace `parsePositionals` with:

```ts
function parsePositionals(argv: string[]): { values: { help?: boolean; org?: string }; positionals: string[] } {
  try {
    // Strict mode still rejects any flag not listed here (e.g. --json).
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { help: { type: "boolean", short: "h" }, org: { type: "string" } },
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 2, true);
  }
}
```

5. Replace `projectCreate` and `projectList`, and add `orgList`:

```ts
async function orgList(db: Database, out: CliOutput): Promise<number> {
  const orgs = await listOrgs(db);
  if (orgs.length === 0) {
    out.stdout("No orgs.");
    return 0;
  }
  const rows = orgs.map((o) => [o.id, o.name, o.createdAt.toISOString(), String(o.memberCount), String(o.projectCount)]);
  formatTable(["ID", "NAME", "CREATED", "MEMBERS", "PROJECTS"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function projectCreate(db: Database, out: CliOutput, orgId: string, rawName: string): Promise<number> {
  const name = rawName.trim();
  if (!name) {
    throw new CliError("Project name is required", 2);
  }
  if (!(await findOrg(db, orgId))) {
    throw new CliError(`Org not found: ${orgId}`, 1);
  }
  const { project, key } = await createProject(db, orgId, name);
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
  const rows = projects.map((p) => [p.id, p.orgId, p.name, p.createdAt.toISOString(), String(p.activeKeyCount)]);
  formatTable(["ID", "ORG", "NAME", "CREATED", "ACTIVE KEYS"], rows).forEach((line) => out.stdout(line));
  return 0;
}
```

- [x] **Step 10: Run all server tests**

Run: `npm test -w server`
Expected: PASS, the whole suite including existing ingest, retention and CLI tests. Then run `npm run typecheck -w server` and `npm run lint -w server`. Both should exit 0.

- [x] **Step 11: Commit**

```bash
git add server/src server/test server/drizzle
git commit -m "feat(server): orgs own projects — schema, backfill migration, org-aware project service and CLI"
```

---

### Task 3: Users and sessions service; CLI password reset

**Files:**
- Create: `server/src/db/users.ts`, `server/src/db/sessions.ts`
- Modify: `server/src/retention.ts`, `server/src/admin.ts`, `server/test/db.ts`
- Test: `server/src/db/users.test.ts`, `server/src/db/sessions.test.ts` (create), `server/src/admin.test.ts` (modify)

**Interfaces:**
- Consumes:
  - `Executor`, `users`, `sessions`, `User` (Task 2).
  - `hashToken`, `generateToken`, `generatePassword`, `hashPassword`, `verifyPassword` (Task 1).
- Produces:
  - `server/src/db/users.ts`:
    - `normalizeEmail(email: string): string`
    - `interface NewUser { email: string; name: string; passwordHash: string | null; githubId: string | null }`
    - `insertUser(ex: Executor, input: NewUser): Promise<User>`
    - `findUserById(ex: Executor, id: string): Promise<User | undefined>`
    - `findUserByEmail(ex: Executor, email: string): Promise<User | undefined>`: normalizes its input.
    - `findUserByGithubId(ex: Executor, githubId: string): Promise<User | undefined>`
    - `countUsers(ex: Executor): Promise<number>`
    - `setPasswordHash(ex: Executor, userId: string, passwordHash: string): Promise<void>`
    - `setGithubId(ex: Executor, userId: string, githubId: string | null): Promise<void>`
  - `server/src/db/sessions.ts`:
    - `SESSION_TTL_MS`
    - `interface CreatedSession { token: string; expiresAt: Date }`
    - `createSession(ex: Executor, userId: string): Promise<CreatedSession>`
    - `findSessionUser(ex: Executor, token: string): Promise<User | undefined>`
    - `deleteSession(ex: Executor, token: string): Promise<void>`
    - `deleteUserSessions(ex: Executor, userId: string, options?: { except?: string }): Promise<void>`
    - `deleteExpiredSessions(ex: Executor): Promise<number>`
  - `server/test/db.ts`:
    - `interface TestUserOptions { email?: string; name?: string; password?: string; githubId?: string }`
    - `createTestUser(db, options?: TestUserOptions): Promise<User>`
    - `sessionCookie(db, userId): Promise<string>`: returns `"repro_session=<token>"`.

- [x] **Step 1: Write the failing tests**

Create `server/src/db/users.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb } from "../../test/db";
import {
  countUsers,
  findUserByEmail,
  findUserByGithubId,
  findUserById,
  insertUser,
  normalizeEmail,
  setGithubId,
  setPasswordHash,
} from "./users";

describe("users", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("normalizes emails by trimming and lowercasing", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });

  it("stores the normalized email and finds the user case-insensitively", async () => {
    const db = getTestDb();
    const user = await insertUser(db, { email: " Ana@Example.com", name: "Ana", passwordHash: null, githubId: null });

    expect(user.email).toBe("ana@example.com");
    expect((await findUserByEmail(db, "ANA@example.com "))?.id).toBe(user.id);
    expect((await findUserById(db, user.id))?.email).toBe("ana@example.com");
  });

  it("rejects a second user with the same email", async () => {
    const db = getTestDb();
    await insertUser(db, { email: "a@example.com", name: "A", passwordHash: null, githubId: null });
    await expect(
      insertUser(db, { email: "A@example.com", name: "B", passwordHash: null, githubId: null })
    ).rejects.toThrow();
  });

  it("counts users", async () => {
    const db = getTestDb();
    expect(await countUsers(db)).toBe(0);
    await createTestUser(db);
    await createTestUser(db);
    expect(await countUsers(db)).toBe(2);
  });

  it("sets and clears the GitHub id", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);

    await setGithubId(db, user.id, "12345");
    expect((await findUserByGithubId(db, "12345"))?.id).toBe(user.id);

    await setGithubId(db, user.id, null);
    expect(await findUserByGithubId(db, "12345")).toBeUndefined();
  });

  it("sets the password hash", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await setPasswordHash(db, user.id, "scrypt$fake");
    expect((await findUserById(db, user.id))?.passwordHash).toBe("scrypt$fake");
  });
});
```

Create `server/src/db/sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestUser, getTestDb, resetDb } from "../../test/db";
import { hashToken } from "../auth/tokens";
import { sessions } from "./schema";
import {
  SESSION_TTL_MS,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  findSessionUser,
} from "./sessions";

describe("sessions", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates a 30-day session and resolves its token to the user", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const before = Date.now();

    const { token, expiresAt } = await createSession(db, user.id);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect((await findSessionUser(db, token))?.id).toBe(user.id);
  });

  it("stores only the token hash", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const { token } = await createSession(db, user.id);

    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("does not resolve unknown or expired tokens", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await db
      .insert(sessions)
      .values({ tokenHash: hashToken("expired"), userId: user.id, expiresAt: new Date(Date.now() - 1000) });

    expect(await findSessionUser(db, "unknown")).toBeUndefined();
    expect(await findSessionUser(db, "expired")).toBeUndefined();
  });

  it("deletes one session", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const { token } = await createSession(db, user.id);

    await deleteSession(db, token);

    expect(await findSessionUser(db, token)).toBeUndefined();
  });

  it("deletes all of a user's sessions, optionally keeping one", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const other = await createTestUser(db);
    const a = await createSession(db, user.id);
    const b = await createSession(db, user.id);
    const c = await createSession(db, other.id);

    await deleteUserSessions(db, user.id, { except: a.token });
    expect(await findSessionUser(db, a.token)).toBeDefined();
    expect(await findSessionUser(db, b.token)).toBeUndefined();

    await deleteUserSessions(db, user.id);
    expect(await findSessionUser(db, a.token)).toBeUndefined();
    expect(await findSessionUser(db, c.token)).toBeDefined();
  });

  it("deletes expired sessions only", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const live = await createSession(db, user.id);
    await db
      .insert(sessions)
      .values({ tokenHash: hashToken("old"), userId: user.id, expiresAt: new Date(Date.now() - 1000) });

    expect(await deleteExpiredSessions(db)).toBe(1);
    expect(await findSessionUser(db, live.token)).toBeDefined();
  });
});
```

In `server/src/admin.test.ts`, add `createTestUser` to the `../test/db` import. Add these imports:

```ts
import { verifyPassword } from "./auth/password";
import { createSession, findSessionUser } from "./db/sessions";
import { findUserById } from "./db/users";
```

Append this block inside the top-level `describe("runCli", ...)`:

```ts
  describe("user reset-password", () => {
    it("sets a new password, prints it once, and logs the user out everywhere", async () => {
      const db = getTestDb();
      const user = await createTestUser(db, { email: "ana@example.com", password: "old-password" });
      const { token } = await createSession(db, user.id);

      const result = await run(["user", "reset-password", "ANA@example.com"]);

      expect(result.code).toBe(0);
      expect(result.stdout[0]).toBe("Reset password for ana@example.com");
      expect(result.stdout[1]).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(result.stdout[2]).toBe("Store this password now. It will not be shown again. The user was logged out everywhere.");
      const updated = await findUserById(db, user.id);
      expect(await verifyPassword(result.stdout[1], updated!.passwordHash!)).toBe(true);
      expect(await findSessionUser(db, token)).toBeUndefined();
    });

    it("exits 1 for an unknown email", async () => {
      const result = await run(["user", "reset-password", "nobody@example.com"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toEqual(["User not found: nobody@example.com"]);
    });
  });
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/db/users.test.ts src/db/sessions.test.ts src/admin.test.ts`
Expected: FAIL. `./users` and `./sessions` can't be resolved, and `createTestUser` is missing.

- [x] **Step 3: Implement**

Create `server/src/db/users.ts`:

```ts
import { count, eq } from "drizzle-orm";
import type { Executor } from "./client";
import { users, type User } from "./schema";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface NewUser {
  email: string;
  name: string;
  passwordHash: string | null;
  githubId: string | null;
}

export async function insertUser(ex: Executor, input: NewUser): Promise<User> {
  const [user] = await ex
    .insert(users)
    .values({ ...input, email: normalizeEmail(input.email) })
    .returning();
  return user;
}

export async function findUserById(ex: Executor, id: string): Promise<User | undefined> {
  const [user] = await ex.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function findUserByEmail(ex: Executor, email: string): Promise<User | undefined> {
  const [user] = await ex.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  return user;
}

export async function findUserByGithubId(ex: Executor, githubId: string): Promise<User | undefined> {
  const [user] = await ex.select().from(users).where(eq(users.githubId, githubId)).limit(1);
  return user;
}

export async function countUsers(ex: Executor): Promise<number> {
  const [row] = await ex.select({ n: count() }).from(users);
  return row.n;
}

export async function setPasswordHash(ex: Executor, userId: string, passwordHash: string): Promise<void> {
  await ex.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function setGithubId(ex: Executor, userId: string, githubId: string | null): Promise<void> {
  await ex.update(users).set({ githubId }).where(eq(users.id, userId));
}
```

Create `server/src/db/sessions.ts`:

```ts
import { and, eq, gt, lte, ne } from "drizzle-orm";
import type { Executor } from "./client";
import { sessions, users, type User } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreatedSession {
  /** Plaintext — goes into the cookie, never stored. */
  token: string;
  expiresAt: Date;
}

export async function createSession(ex: Executor, userId: string): Promise<CreatedSession> {
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await ex.insert(sessions).values({ tokenHash: hash, userId, expiresAt });
  return { token, expiresAt };
}

export async function findSessionUser(ex: Executor, token: string): Promise<User | undefined> {
  const [row] = await ex
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row?.user;
}

export async function deleteSession(ex: Executor, token: string): Promise<void> {
  await ex.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Logs a user out everywhere, or everywhere except the session holding `except`. */
export async function deleteUserSessions(ex: Executor, userId: string, options: { except?: string } = {}): Promise<void> {
  await ex
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        options.except === undefined ? undefined : ne(sessions.tokenHash, hashToken(options.except))
      )
    );
}

export async function deleteExpiredSessions(ex: Executor): Promise<number> {
  const deleted = await ex
    .delete(sessions)
    .where(lte(sessions.expiresAt, new Date()))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}
```

Append to `server/test/db.ts`. Also add `import { hashPassword } from "../src/auth/password";`, `import { insertUser } from "../src/db/users";` and `import { createSession } from "../src/db/sessions";` to its imports:

```ts
let userSeq = 0;

export interface TestUserOptions {
  email?: string;
  name?: string;
  /** Hashed with real scrypt (~100ms) — only pass one when the test logs in with it. */
  password?: string;
  githubId?: string;
}

export async function createTestUser(db: Database, options: TestUserOptions = {}): Promise<User> {
  userSeq += 1;
  return insertUser(db, {
    email: options.email ?? `user${userSeq}@example.com`,
    name: options.name ?? `User ${userSeq}`,
    passwordHash: options.password === undefined ? null : await hashPassword(options.password),
    githubId: options.githubId ?? null,
  });
}

/** A Cookie header value holding a fresh session for the user. */
export async function sessionCookie(db: Database, userId: string): Promise<string> {
  const { token } = await createSession(db, userId);
  // Must match SESSION_COOKIE in src/auth/http.ts.
  return `repro_session=${token}`;
}
```

In `server/src/retention.ts`, import `deleteExpiredSessions` from `./db/sessions`. Replace `scheduleCleanup` with:

```ts
export function scheduleCleanup(
  db: Database,
  retentionDays: number,
  intervalMs: number = 24 * 60 * 60 * 1000
): ReturnType<typeof setInterval> {
  const run = () => {
    Promise.all([cleanupOldTimelines(db, retentionDays), deleteExpiredSessions(db)]).catch((error: unknown) => {
      console.error("[repro-server] cleanup job failed:", error);
    });
  };

  // Run once immediately at boot, not just on the interval — otherwise any
  // deployment that restarts more often than `intervalMs` (default 24h)
  // never enforces retention at all.
  run();
  return setInterval(run, intervalMs);
}
```

In `server/src/admin.ts`:

1. Add these imports:

```ts
import { hashPassword } from "./auth/password";
import { generatePassword } from "./auth/tokens";
import { deleteUserSessions } from "./db/sessions";
import { findUserByEmail, setPasswordHash } from "./db/users";
```

2. In `USAGE`, add this line after `key revoke`:
   `  user reset-password <email>             Set a new random password and log the user out everywhere`
3. In the `switch`, add:

```ts
      case "user reset-password":
        return await userResetPassword(db, out, singleArg(rest, "<email>"));
```

4. Append:

```ts
async function userResetPassword(db: Database, out: CliOutput, email: string): Promise<number> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new CliError(`User not found: ${email}`, 1);
  }
  const password = generatePassword();
  await setPasswordHash(db, user.id, await hashPassword(password));
  await deleteUserSessions(db, user.id);
  out.stdout(`Reset password for ${user.email}`);
  out.stdout(password);
  out.stdout("Store this password now. It will not be shown again. The user was logged out everywhere.");
  return 0;
}
```

- [x] **Step 4: Run all server tests**

Run: `npm test -w server`
Expected: PASS. Then run `npm run typecheck -w server && npm run lint -w server`. Both should exit 0.

- [x] **Step 5: Commit**

```bash
git add server/src server/test
git commit -m "feat(server): add users and sessions service, expire sessions in cleanup, CLI password reset"
```

---
### Task 4: Org membership service and the last-owner rule

**Files:**
- Modify: `server/src/db/orgs.ts`
- Test: `server/src/db/orgs.test.ts`

**Interfaces:**
- Consumes: `Executor`, `orgs`, `memberships`, `users`, `Role`, `Membership` (Task 2); `createTestUser` (Task 3).
- Produces, in `server/src/db/orgs.ts`:
  - `interface UserOrg { id: string; name: string; role: Role }`
  - `interface Member { userId: string; name: string; email: string; role: Role; joinedAt: Date }`
  - `type MembershipChange = { ok: true } | { ok: false; reason: "not_found" | "last_owner" }`
  - `addMember(ex: Executor, orgId: string, userId: string, role: Role): Promise<Membership>`
  - `createOrgWithOwner(ex: Executor, userId: string, name: string): Promise<Org>`
  - `getMembership(ex: Executor, orgId: string, userId: string): Promise<Membership | undefined>`
  - `listUserOrgs(ex: Executor, userId: string): Promise<UserOrg[]>`: ordered by join time.
  - `listMembers(ex: Executor, orgId: string): Promise<Member[]>`: ordered by join time.
  - `renameOrg(ex: Executor, orgId: string, name: string): Promise<Org | undefined>`
  - `listMemberlessOrgIds(ex: Executor): Promise<string[]>`
  - `changeRole(ex: Executor, orgId: string, userId: string, role: Role): Promise<MembershipChange>`
  - `removeMember(ex: Executor, orgId: string, userId: string): Promise<MembershipChange>`

- [x] **Step 1: Write the failing tests**

Append to `server/src/db/orgs.test.ts`. Extend its imports: add `createTestUser` from `../../test/db`, and add every new function listed above to the `./orgs` import.

```ts
describe("memberships", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("createOrgWithOwner creates the org with the user as owner", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);

    const org = await createOrgWithOwner(db, user.id, "Acme");

    expect((await getMembership(db, org.id, user.id))?.role).toBe("owner");
  });

  it("lists a user's orgs in the order they joined", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const first = await createOrgWithOwner(db, user.id, "Zeta");
    const second = await createTestOrg(db, "Alpha");
    await addMember(db, second.id, user.id, "member");
    await createTestOrg(db, "Not mine");

    expect(await listUserOrgs(db, user.id)).toEqual([
      { id: first.id, name: "Zeta", role: "owner" },
      { id: second.id, name: "Alpha", role: "member" },
    ]);
  });

  it("lists an org's members with name, email, role and join time", async () => {
    const db = getTestDb();
    const owner = await createTestUser(db, { name: "Olga", email: "olga@example.com" });
    const member = await createTestUser(db, { name: "Mark", email: "mark@example.com" });
    const org = await createOrgWithOwner(db, owner.id, "Acme");
    await addMember(db, org.id, member.id, "member");

    const result = await listMembers(db, org.id);

    expect(result.map((m) => [m.userId, m.name, m.email, m.role])).toEqual([
      [owner.id, "Olga", "olga@example.com", "owner"],
      [member.id, "Mark", "mark@example.com", "member"],
    ]);
    expect(result[0].joinedAt).toBeInstanceOf(Date);
  });

  it("renames an org", async () => {
    const db = getTestDb();
    const org = await createTestOrg(db, "Old");
    expect((await renameOrg(db, org.id, "New"))?.name).toBe("New");
    expect(await renameOrg(db, "00000000-0000-0000-0000-000000000000", "X")).toBeUndefined();
  });

  it("lists orgs that have no members", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const orphan = await createTestOrg(db, "Default");
    await createOrgWithOwner(db, user.id, "Owned");

    expect(await listMemberlessOrgIds(db)).toEqual([orphan.id]);
  });
});

describe("changeRole / removeMember", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  async function orgWith(roles: ("owner" | "member")[]) {
    const db = getTestDb();
    const org = await createTestOrg(db);
    const members = [];
    for (const role of roles) {
      const user = await createTestUser(db);
      await addMember(db, org.id, user.id, role);
      members.push(user);
    }
    return { org, members };
  }

  it("promotes and demotes when another owner remains", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "member"]);

    expect(await changeRole(db, org.id, members[1].id, "owner")).toEqual({ ok: true });
    expect(await changeRole(db, org.id, members[0].id, "member")).toEqual({ ok: true });
    expect((await getMembership(db, org.id, members[0].id))?.role).toBe("member");
  });

  it("refuses to demote the last owner", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "member"]);

    expect(await changeRole(db, org.id, members[0].id, "member")).toEqual({ ok: false, reason: "last_owner" });
    expect((await getMembership(db, org.id, members[0].id))?.role).toBe("owner");
  });

  it("reports not_found for a non-member", async () => {
    const db = getTestDb();
    const { org } = await orgWith(["owner"]);
    const stranger = await createTestUser(db);

    expect(await changeRole(db, org.id, stranger.id, "owner")).toEqual({ ok: false, reason: "not_found" });
    expect(await removeMember(db, org.id, stranger.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("removes members but never the last owner", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "member"]);

    expect(await removeMember(db, org.id, members[1].id)).toEqual({ ok: true });
    expect(await getMembership(db, org.id, members[1].id)).toBeUndefined();
    expect(await removeMember(db, org.id, members[0].id)).toEqual({ ok: false, reason: "last_owner" });
  });

  it("two owners demoting each other at the same time leaves exactly one owner", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "owner"]);

    const results = await Promise.all([
      changeRole(db, org.id, members[0].id, "member"),
      changeRole(db, org.id, members[1].id, "member"),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const roles = (await listMembers(db, org.id)).map((m) => m.role);
    expect(roles.filter((r) => r === "owner")).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/db/orgs.test.ts`
Expected: FAIL. `addMember`, `createOrgWithOwner` and the other new functions are not exported.

- [x] **Step 3: Implement**

In `server/src/db/orgs.ts`:
- Change the drizzle import to `import { and, asc, eq, isNull, sql } from "drizzle-orm";`.
- Change the schema import to `import { memberships, orgs, projects, users, type Membership, type Org, type Role } from "./schema";`.
- Append:

```ts
export interface UserOrg {
  id: string;
  name: string;
  role: Role;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

export type MembershipChange = { ok: true } | { ok: false; reason: "not_found" | "last_owner" };

export async function addMember(ex: Executor, orgId: string, userId: string, role: Role): Promise<Membership> {
  const [membership] = await ex.insert(memberships).values({ orgId, userId, role }).returning();
  return membership;
}

export async function createOrgWithOwner(ex: Executor, userId: string, name: string): Promise<Org> {
  // Nested inside a caller's transaction, this becomes a savepoint.
  return ex.transaction(async (tx) => {
    const org = await createOrg(tx, name);
    await addMember(tx, org.id, userId, "owner");
    return org;
  });
}

export async function getMembership(ex: Executor, orgId: string, userId: string): Promise<Membership | undefined> {
  const [membership] = await ex
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return membership;
}

export async function listUserOrgs(ex: Executor, userId: string): Promise<UserOrg[]> {
  return ex
    .select({ id: orgs.id, name: orgs.name, role: memberships.role })
    .from(memberships)
    .innerJoin(orgs, eq(memberships.orgId, orgs.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(orgs.name));
}

export async function listMembers(ex: Executor, orgId: string): Promise<Member[]> {
  return ex
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt));
}

export async function renameOrg(ex: Executor, orgId: string, name: string): Promise<Org | undefined> {
  const [org] = await ex.update(orgs).set({ name }).where(eq(orgs.id, orgId)).returning();
  return org;
}

// Orgs nobody can reach — in practice the "Default" org the 0002 migration creates
// for projects that predate orgs. The first user to sign up takes them over.
export async function listMemberlessOrgIds(ex: Executor): Promise<string[]> {
  const rows = await ex
    .select({ id: orgs.id })
    .from(orgs)
    .leftJoin(memberships, eq(memberships.orgId, orgs.id))
    .where(isNull(memberships.userId));
  return rows.map((row) => row.id);
}

// Locks every membership row of the org for the rest of the transaction, so two
// concurrent demotions/removals can't each see "another owner remains" and
// together leave the org without an owner.
async function withLockedMembers(
  ex: Executor,
  orgId: string,
  fn: (tx: Executor, members: Membership[]) => Promise<MembershipChange>
): Promise<MembershipChange> {
  return ex.transaction(async (tx) => {
    const members = await tx.select().from(memberships).where(eq(memberships.orgId, orgId)).for("update");
    return fn(tx, members);
  });
}

function isLastOwner(members: Membership[], target: Membership): boolean {
  return target.role === "owner" && members.filter((m) => m.role === "owner").length === 1;
}

export async function changeRole(ex: Executor, orgId: string, userId: string, role: Role): Promise<MembershipChange> {
  return withLockedMembers(ex, orgId, async (tx, members) => {
    const target = members.find((m) => m.userId === userId);
    if (!target) {
      return { ok: false, reason: "not_found" };
    }
    if (role !== "owner" && isLastOwner(members, target)) {
      return { ok: false, reason: "last_owner" };
    }
    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    return { ok: true };
  });
}

export async function removeMember(ex: Executor, orgId: string, userId: string): Promise<MembershipChange> {
  return withLockedMembers(ex, orgId, async (tx, members) => {
    const target = members.find((m) => m.userId === userId);
    if (!target) {
      return { ok: false, reason: "not_found" };
    }
    if (isLastOwner(members, target)) {
      return { ok: false, reason: "last_owner" };
    }
    await tx.delete(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    return { ok: true };
  });
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/db/orgs.test.ts`
Expected: PASS. If the concurrency test is flaky (both succeed), the `.for("update")` lock is missing.

- [x] **Step 5: Commit**

```bash
git add server/src/db/orgs.ts server/src/db/orgs.test.ts
git commit -m "feat(server): add org membership service with a locked last-owner rule"
```

---

### Task 5: Invites service and account flows (signup, accept invite)

**Files:**
- Create: `server/src/db/invites.ts`, `server/src/accounts.ts`
- Test: `server/src/db/invites.test.ts`, `server/src/accounts.test.ts`

**Interfaces:**
- Consumes: `generateToken`, `hashToken` (Task 1); users service (Task 3); orgs service (Tasks 2 and 4).
- Produces:
  - `server/src/db/invites.ts`:
    - `INVITE_TTL_MS`
    - `interface InviteSummary { id: string; role: Role; createdAt: Date; expiresAt: Date; createdByName: string }`
    - `interface CreatedInvite { invite: InviteSummary; token: string }`
    - `interface UsableInvite { id: string; orgId: string; orgName: string; role: Role }`
    - `createInvite(ex: Executor, input: { orgId: string; role: Role; createdBy: string }): Promise<CreatedInvite>`
    - `listPendingInvites(ex: Executor, orgId: string): Promise<InviteSummary[]>`
    - `revokeInvite(ex: Executor, orgId: string, inviteId: string): Promise<boolean>`
    - `findUsableInvite(ex: Executor, token: string): Promise<UsableInvite | undefined>`
    - `consumeInvite(ex: Executor, inviteId: string, userId: string): Promise<boolean>`
  - `server/src/accounts.ts`:
    - `SIGNUP_MODES = ["open", "invite-only"] as const`, `type SignupMode`
    - `interface SignUpInput { email: string; name: string; passwordHash: string | null; githubId: string | null; inviteToken?: string; mode: SignupMode }`
    - `type SignUpResult = { ok: true; user: User } | { ok: false; reason: "signup_closed" | "invite_invalid" | "email_taken" | "github_taken" }`
    - `signUp(db: Database, input: SignUpInput): Promise<SignUpResult>`
    - `type AcceptInviteResult = { ok: true; orgId: string } | { ok: false; reason: "not_found" | "already_member" }`
    - `acceptInvite(db: Database, token: string, userId: string): Promise<AcceptInviteResult>`

- [x] **Step 1: Write the failing tests**

Create `server/src/db/invites.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestOrg, createTestUser, getTestDb, resetDb } from "../../test/db";
import { hashToken } from "../auth/tokens";
import { invites } from "./schema";
import {
  INVITE_TTL_MS,
  consumeInvite,
  createInvite,
  findUsableInvite,
  listPendingInvites,
  revokeInvite,
} from "./invites";

async function setup() {
  const db = getTestDb();
  const org = await createTestOrg(db, "Acme");
  const creator = await createTestUser(db, { name: "Olga" });
  return { db, org, creator };
}

describe("invites", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates a 7-day rpi_ invite and stores only its hash", async () => {
    const { db, org, creator } = await setup();
    const before = Date.now();

    const { invite, token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });

    expect(token).toMatch(/^rpi_[A-Za-z0-9_-]{43}$/);
    expect(invite.role).toBe("member");
    expect(invite.createdByName).toBe("Olga");
    expect(invite.expiresAt.getTime()).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    const [row] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("finds a usable invite by token, with its org name", async () => {
    const { db, org, creator } = await setup();
    const { invite, token } = await createInvite(db, { orgId: org.id, role: "owner", createdBy: creator.id });

    expect(await findUsableInvite(db, token)).toEqual({ id: invite.id, orgId: org.id, orgName: "Acme", role: "owner" });
    expect(await findUsableInvite(db, "rpi_unknown")).toBeUndefined();
  });

  it("consumes an invite exactly once", async () => {
    const { db, org, creator } = await setup();
    const joiner = await createTestUser(db);
    const { invite, token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });

    expect(await consumeInvite(db, invite.id, joiner.id)).toBe(true);
    expect(await consumeInvite(db, invite.id, joiner.id)).toBe(false);
    expect(await findUsableInvite(db, token)).toBeUndefined();
  });

  it("treats expired and revoked invites as unusable", async () => {
    const { db, org, creator } = await setup();
    const expired = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, expired.invite.id));
    const revoked = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    await revokeInvite(db, org.id, revoked.invite.id);

    expect(await findUsableInvite(db, expired.token)).toBeUndefined();
    expect(await findUsableInvite(db, revoked.token)).toBeUndefined();
    expect(await consumeInvite(db, expired.invite.id, creator.id)).toBe(false);
  });

  it("lists only pending invites, oldest first", async () => {
    const { db, org, creator } = await setup();
    const a = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    const b = await createInvite(db, { orgId: org.id, role: "owner", createdBy: creator.id });
    const c = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    await revokeInvite(db, org.id, c.invite.id);
    await consumeInvite(db, a.invite.id, creator.id);

    expect(await listPendingInvites(db, org.id)).toEqual([b.invite]);
  });

  it("revokes only a pending invite of the given org", async () => {
    const { db, org, creator } = await setup();
    const other = await createTestOrg(db, "Other");
    const { invite } = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });

    expect(await revokeInvite(db, other.id, invite.id)).toBe(false);
    expect(await revokeInvite(db, org.id, invite.id)).toBe(true);
    expect(await revokeInvite(db, org.id, invite.id)).toBe(false);
  });
});
```

Create `server/src/accounts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestOrg, createTestUser, getTestDb, resetDb } from "../test/db";
import { invites } from "./db/schema";
import { createInvite, findUsableInvite } from "./db/invites";
import { addMember, getMembership, listUserOrgs } from "./db/orgs";
import { acceptInvite, signUp, type SignUpInput } from "./accounts";

function input(overrides: Partial<SignUpInput> = {}): SignUpInput {
  return {
    email: "ana@example.com",
    name: "Ana",
    passwordHash: "scrypt$fake",
    githubId: null,
    mode: "open",
    ...overrides,
  };
}

async function inviteTo(orgName = "Acme", role: "owner" | "member" = "member") {
  const db = getTestDb();
  const org = await createTestOrg(db, orgName);
  const owner = await createTestUser(db);
  await addMember(db, org.id, owner.id, "owner");
  const { invite, token } = await createInvite(db, { orgId: org.id, role, createdBy: owner.id });
  return { org, owner, invite, token };
}

describe("signUp", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("open signup creates the user with a personal org they own", async () => {
    await createTestUser(getTestDb()); // not the first user
    const result = await signUp(getTestDb(), input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.email).toBe("ana@example.com");
    const orgs = await listUserOrgs(getTestDb(), result.user.id);
    expect(orgs).toEqual([{ id: expect.any(String), name: "Ana's org", role: "owner" }]);
  });

  it("invite-only signup is closed once the instance has users", async () => {
    await createTestUser(getTestDb());
    expect(await signUp(getTestDb(), input({ mode: "invite-only" }))).toEqual({ ok: false, reason: "signup_closed" });
  });

  it("the first user bootstraps an invite-only instance with a personal org", async () => {
    const result = await signUp(getTestDb(), input({ mode: "invite-only" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await listUserOrgs(getTestDb(), result.user.id)).map((o) => o.name)).toEqual(["Ana's org"]);
  });

  it("the first user takes over memberless orgs instead of getting a personal org", async () => {
    const legacy = await createTestOrg(getTestDb(), "Default");

    const result = await signUp(getTestDb(), input({ mode: "invite-only" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await listUserOrgs(getTestDb(), result.user.id)).toEqual([
      { id: legacy.id, name: "Default", role: "owner" },
    ]);
  });

  it("an invite signup joins the invite's org with its role, consumes the invite, and gets no personal org", async () => {
    const { org, token } = await inviteTo("Acme", "member");

    const result = await signUp(getTestDb(), input({ mode: "invite-only", inviteToken: token }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await listUserOrgs(getTestDb(), result.user.id)).toEqual([{ id: org.id, name: "Acme", role: "member" }]);
    expect(await findUsableInvite(getTestDb(), token)).toBeUndefined();
  });

  it("an unusable invite token fails even when signup is open", async () => {
    await createTestUser(getTestDb());
    expect(await signUp(getTestDb(), input({ inviteToken: "rpi_nope" }))).toEqual({
      ok: false,
      reason: "invite_invalid",
    });
  });

  it("rejects a taken email regardless of case, leaving the invite unused", async () => {
    const { token } = await inviteTo();
    await createTestUser(getTestDb(), { email: "ana@example.com" });

    expect(await signUp(getTestDb(), input({ email: "ANA@example.com", inviteToken: token }))).toEqual({
      ok: false,
      reason: "email_taken",
    });
    expect(await findUsableInvite(getTestDb(), token)).toBeDefined();
  });

  it("rejects a GitHub id that is already linked", async () => {
    await createTestUser(getTestDb(), { githubId: "42" });
    expect(await signUp(getTestDb(), input({ githubId: "42", passwordHash: null }))).toEqual({
      ok: false,
      reason: "github_taken",
    });
  });

  it("two concurrent first signups on an invite-only instance bootstrap exactly once", async () => {
    const results = await Promise.all([
      signUp(getTestDb(), input({ mode: "invite-only", email: "a@example.com" })),
      signUp(getTestDb(), input({ mode: "invite-only", email: "b@example.com" })),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "signup_closed" }]);
  });
});

describe("acceptInvite", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("adds the user to the org with the invite's role", async () => {
    const { org, token } = await inviteTo("Acme", "owner");
    const user = await createTestUser(getTestDb());

    expect(await acceptInvite(getTestDb(), token, user.id)).toEqual({ ok: true, orgId: org.id });
    expect((await getMembership(getTestDb(), org.id, user.id))?.role).toBe("owner");
  });

  it("refuses an existing member and leaves the invite usable", async () => {
    const { owner, token } = await inviteTo();

    expect(await acceptInvite(getTestDb(), token, owner.id)).toEqual({ ok: false, reason: "already_member" });
    expect(await findUsableInvite(getTestDb(), token)).toBeDefined();
  });

  it("is single-use", async () => {
    const { token } = await inviteTo();
    const first = await createTestUser(getTestDb());
    const second = await createTestUser(getTestDb());

    await acceptInvite(getTestDb(), token, first.id);

    expect(await acceptInvite(getTestDb(), token, second.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an expired invite", async () => {
    const { invite, token } = await inviteTo();
    await getTestDb()
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.id, invite.id));
    const user = await createTestUser(getTestDb());

    expect(await acceptInvite(getTestDb(), token, user.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("lets only one of two concurrent acceptances through", async () => {
    const { token } = await inviteTo();
    const a = await createTestUser(getTestDb());
    const b = await createTestUser(getTestDb());

    const results = await Promise.all([
      acceptInvite(getTestDb(), token, a.id),
      acceptInvite(getTestDb(), token, b.id),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/db/invites.test.ts src/accounts.test.ts`
Expected: FAIL. `./invites` and `./accounts` can't be resolved.

- [x] **Step 3: Implement**

Create `server/src/db/invites.ts`:

```ts
import { and, asc, eq, gt, isNull, type SQL } from "drizzle-orm";
import type { Executor } from "./client";
import { invites, orgs, users, type Role } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteSummary {
  id: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
  createdByName: string;
}

export interface CreatedInvite {
  invite: InviteSummary;
  /** Plaintext rpi_ token — shown once, never stored. */
  token: string;
}

export interface UsableInvite {
  id: string;
  orgId: string;
  orgName: string;
  role: Role;
}

// Not accepted, not revoked, not expired. Every read and write of an invite
// goes through this, so a used/revoked/expired invite behaves as if it didn't exist.
function usable(): SQL {
  return and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())) as SQL;
}

async function inviteSummaries(ex: Executor, where: SQL | undefined): Promise<InviteSummary[]> {
  return ex
    .select({
      id: invites.id,
      role: invites.role,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      createdByName: users.name,
    })
    .from(invites)
    .innerJoin(users, eq(invites.createdBy, users.id))
    .where(where)
    .orderBy(asc(invites.createdAt));
}

export async function createInvite(
  ex: Executor,
  input: { orgId: string; role: Role; createdBy: string }
): Promise<CreatedInvite> {
  const { token, hash } = generateToken("rpi_");
  const [row] = await ex
    .insert(invites)
    .values({ ...input, tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
    .returning({ id: invites.id });
  const [invite] = await inviteSummaries(ex, eq(invites.id, row.id));
  return { invite, token };
}

export async function listPendingInvites(ex: Executor, orgId: string): Promise<InviteSummary[]> {
  return inviteSummaries(ex, and(eq(invites.orgId, orgId), usable()));
}

/** True if a pending invite of this org was revoked; false if there was none. */
export async function revokeInvite(ex: Executor, orgId: string, inviteId: string): Promise<boolean> {
  const revoked = await ex
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, inviteId), eq(invites.orgId, orgId), usable()))
    .returning({ id: invites.id });
  return revoked.length > 0;
}

export async function findUsableInvite(ex: Executor, token: string): Promise<UsableInvite | undefined> {
  const [invite] = await ex
    .select({ id: invites.id, orgId: invites.orgId, orgName: orgs.name, role: invites.role })
    .from(invites)
    .innerJoin(orgs, eq(invites.orgId, orgs.id))
    .where(and(eq(invites.tokenHash, hashToken(token)), usable()))
    .limit(1);
  return invite;
}

// Conditional update: of two concurrent consumers, the second waits on the row
// lock, then re-checks `accepted_at IS NULL`, finds it set, and updates nothing.
export async function consumeInvite(ex: Executor, inviteId: string, userId: string): Promise<boolean> {
  const consumed = await ex
    .update(invites)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(and(eq(invites.id, inviteId), usable()))
    .returning({ id: invites.id });
  return consumed.length > 0;
}
```

Create `server/src/accounts.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Database } from "./db/client";
import type { User } from "./db/schema";
import { consumeInvite, findUsableInvite } from "./db/invites";
import { addMember, createOrgWithOwner, getMembership, listMemberlessOrgIds } from "./db/orgs";
import { countUsers, findUserByEmail, findUserByGithubId, insertUser } from "./db/users";

export const SIGNUP_MODES = ["open", "invite-only"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

// Arbitrary app-wide constant (next to MIGRATION_LOCK_ID in db/migrate.ts).
const SIGNUP_LOCK_ID = 727_402;

export interface SignUpInput {
  email: string;
  name: string;
  passwordHash: string | null;
  githubId: string | null;
  inviteToken?: string;
  mode: SignupMode;
}

type SignUpFailure = "signup_closed" | "invite_invalid" | "email_taken" | "github_taken";

export type SignUpResult = { ok: true; user: User } | { ok: false; reason: SignUpFailure };

// Thrown inside the transaction to roll it back, then turned into a result.
class SignUpAborted extends Error {
  constructor(readonly reason: SignUpFailure) {
    super(reason);
  }
}

function personalOrgName(name: string): string {
  return `${name.slice(0, 94)}'s org`;
}

export async function signUp(db: Database, input: SignUpInput): Promise<SignUpResult> {
  try {
    const user = await db.transaction(async (tx) => {
      // Serializes signups, so two concurrent "first" signups can't both see an
      // empty users table and both bootstrap the instance.
      await tx.execute(sql`select pg_advisory_xact_lock(${SIGNUP_LOCK_ID})`);
      const bootstrap = (await countUsers(tx)) === 0;
      const invite = input.inviteToken === undefined ? undefined : await findUsableInvite(tx, input.inviteToken);
      if (input.inviteToken !== undefined && !invite) {
        throw new SignUpAborted("invite_invalid");
      }
      if (input.mode === "invite-only" && !bootstrap && !invite) {
        throw new SignUpAborted("signup_closed");
      }
      if (await findUserByEmail(tx, input.email)) {
        throw new SignUpAborted("email_taken");
      }
      if (input.githubId !== null && (await findUserByGithubId(tx, input.githubId))) {
        throw new SignUpAborted("github_taken");
      }

      const created = await insertUser(tx, {
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        githubId: input.githubId,
      });

      if (invite) {
        // An existing user (who doesn't take the signup lock) may have accepted
        // this invite since it was read above.
        if (!(await consumeInvite(tx, invite.id, created.id))) {
          throw new SignUpAborted("invite_invalid");
        }
        await addMember(tx, invite.orgId, created.id, invite.role);
        return created;
      }

      const orphaned = bootstrap ? await listMemberlessOrgIds(tx) : [];
      if (orphaned.length > 0) {
        for (const orgId of orphaned) {
          await addMember(tx, orgId, created.id, "owner");
        }
      } else {
        await createOrgWithOwner(tx, created.id, personalOrgName(created.name));
      }
      return created;
    });
    return { ok: true, user };
  } catch (error) {
    if (error instanceof SignUpAborted) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}

export type AcceptInviteResult = { ok: true; orgId: string } | { ok: false; reason: "not_found" | "already_member" };

export async function acceptInvite(db: Database, token: string, userId: string): Promise<AcceptInviteResult> {
  return db.transaction(async (tx) => {
    const invite = await findUsableInvite(tx, token);
    if (!invite) {
      return { ok: false, reason: "not_found" };
    }
    // Checked before consuming, so an accidental click by a member doesn't burn the link.
    if (await getMembership(tx, invite.orgId, userId)) {
      return { ok: false, reason: "already_member" };
    }
    if (!(await consumeInvite(tx, invite.id, userId))) {
      return { ok: false, reason: "not_found" };
    }
    await addMember(tx, invite.orgId, userId, invite.role);
    return { ok: true, orgId: invite.orgId };
  });
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/db/invites.test.ts src/accounts.test.ts`
Expected: PASS.

- [x] **Step 5: Run the full suite, typecheck, lint**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`
Expected: all PASS / exit 0.

- [x] **Step 6: Commit**

```bash
git add server/src/db/invites.ts server/src/db/invites.test.ts server/src/accounts.ts server/src/accounts.test.ts
git commit -m "feat(server): add invites service and transactional signup/accept-invite flows"
```

---

### Task 6: HTTP foundation: config, cookies, scoped CORS, CSRF guard, session auth

**Files:**
- Create: `server/src/config.ts`, `server/src/auth/http.ts`, `server/src/rate-limit.ts`, `server/src/routes/context.ts`, `server/src/routes/errors.ts`, `server/src/routes/auth.ts`, `server/src/routes/me.ts`, `server/test/http.ts`
- Modify: `server/src/app.ts`, `server/src/index.ts`, `server/src/routes/timeline.ts`, `server/package.json`
- Test: `server/src/config.test.ts`, `server/src/routes/auth.test.ts`, `server/src/routes/me.test.ts` (create); `server/src/app.test.ts` (modify)

**Interfaces:**
- Consumes: `SignupMode`, `SIGNUP_MODES` (Task 5); sessions and users services (Task 3); `getMembership`, `listUserOrgs` (Task 4); `isUuid` (Task 2).
- Produces:
  - `server/src/config.ts`:
    - `interface GithubConfig { clientId: string; clientSecret: string; baseUrl: string }`
    - `interface DashboardConfig { publicUrl: string; signup: SignupMode; github?: GithubConfig; trustProxy: boolean; dashboardDir: string }`
    - `loadDashboardConfig(env: Record<string, string | undefined>, defaultDashboardDir: string): DashboardConfig`: throws on invalid values.
  - `server/src/auth/http.ts`:
    - `SESSION_COOKIE = "repro_session"`
    - `startSession(db, reply, userId, secure): Promise<void>`
    - `clearSessionCookie(reply): void`
    - `csrfGuard(publicOrigin: string)`: an `onRequest` hook.
    - `requireUser(db)`, `requireMembership(db, minRole: Role)`: `preValidation` hooks.
    - `currentUser(request): User`, `currentMembership(request): Membership`
    - It also adds `user`, `sessionToken` and `membership` to `FastifyRequest`.
  - `server/src/rate-limit.ts`: `rateLimitErrorBody(request, context)`.
  - `server/src/routes/context.ts`: `interface ApiContext { db; publicUrl; secureCookies; signup; github?; githubFetch; authRateLimitMax }`.
  - `server/src/routes/errors.ts`:
    - `httpError(statusCode: number, message: string): Error & { statusCode: number }`
    - `requireName(value: string, message: string): string`
  - `server/src/routes/me.ts`:
    - `interface MeBody { user: { id; email; name; hasPassword; githubConnected }; orgs: UserOrg[] }`
    - `meBody(db, user): Promise<MeBody>`
    - `registerMeRoutes(app, ctx)`
  - `server/src/routes/auth.ts`: `registerAuthRoutes(app, ctx)`. This task adds `GET /api/auth/config` and `POST /api/auth/logout`.
  - `server/src/app.ts`: `AppOptions` gains `publicUrl`, `signup`, `github`, `githubFetch`, `trustProxy`, `dashboardDir`, `authRateLimitMax` and `onRoute`.
  - `server/test/http.ts`:
    - `TEST_ORIGIN = "http://localhost:3000"`
    - `buildTestApp(db, options?)`
    - `call(app, method, url, options?: { cookie?; body?; headers? })`, which adds `Origin: TEST_ORIGIN` on non-GET requests.

- [x] **Step 1: Add the Fastify plugins**

Run from the repo root: `npm install -w server @fastify/cookie@^11 @fastify/static@^8`
Expected: `server/package.json` dependencies now list both packages. (`@fastify/static` is used in Task 11.)

- [x] **Step 2: Write the failing tests**

Create `server/test/http.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/app";
import type { Database } from "../src/db/client";

/** buildApp's default publicUrl; non-GET /api requests must send it as Origin. */
export const TEST_ORIGIN = "http://localhost:3000";

export function buildTestApp(db: Database, options: AppOptions = {}): Promise<FastifyInstance> {
  return buildApp(db, { logLevel: "silent", ...options });
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface CallOptions {
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

// app.inject with what a same-origin browser request would carry: an Origin on
// non-GET requests, the session cookie, and a JSON body (inject sets the JSON
// content type for object payloads; body-less requests get no content type).
export function call(app: FastifyInstance, method: Method, url: string, options: CallOptions = {}) {
  return app.inject({
    method,
    url,
    headers: {
      ...(method === "GET" ? {} : { origin: TEST_ORIGIN }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
}
```

Create `server/src/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadDashboardConfig } from "./config";

describe("loadDashboardConfig", () => {
  it("applies defaults", () => {
    expect(loadDashboardConfig({}, "/default/dist")).toEqual({
      publicUrl: "http://localhost:3000",
      signup: "invite-only",
      github: undefined,
      trustProxy: false,
      dashboardDir: "/default/dist",
    });
  });

  it("reads every variable", () => {
    const config = loadDashboardConfig(
      {
        PUBLIC_URL: "https://app.reprojs.dev/",
        SIGNUP: "open",
        GITHUB_CLIENT_ID: "id",
        GITHUB_CLIENT_SECRET: "secret",
        GITHUB_BASE_URL: "https://ghe.example.com",
        TRUST_PROXY: "true",
        DASHBOARD_DIR: "/srv/dashboard",
      },
      "/default/dist"
    );
    expect(config).toEqual({
      publicUrl: "https://app.reprojs.dev",
      signup: "open",
      github: { clientId: "id", clientSecret: "secret", baseUrl: "https://ghe.example.com" },
      trustProxy: true,
      dashboardDir: "/srv/dashboard",
    });
  });

  it("defaults the GitHub base URL", () => {
    const config = loadDashboardConfig({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }, "/d");
    expect(config.github?.baseUrl).toBe("https://github.com");
  });

  it.each([
    [{ SIGNUP: "closed" }, 'SIGNUP must be "open" or "invite-only"'],
    [{ GITHUB_CLIENT_ID: "id" }, "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together"],
    [{ GITHUB_CLIENT_SECRET: "s" }, "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together"],
    [{ PUBLIC_URL: "app.reprojs.dev" }, "PUBLIC_URL must be an absolute http(s) URL"],
    [{ PUBLIC_URL: "ftp://x.dev" }, "PUBLIC_URL must be an absolute http(s) URL"],
  ])("rejects %o", (env, message) => {
    expect(() => loadDashboardConfig(env, "/d")).toThrow(message);
  });
});
```

Create `server/src/routes/me.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { hashToken } from "../auth/tokens";
import { createOrgWithOwner } from "../db/orgs";
import { sessions } from "../db/schema";

describe("GET /api/me", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns 401 without a session cookie", async () => {
    const app = await buildTestApp(getTestDb());
    const response = await call(app, "GET", "/api/me");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Not logged in" });
  });

  it("returns 401 for an unknown token", async () => {
    const app = await buildTestApp(getTestDb());
    const response = await call(app, "GET", "/api/me", { cookie: "repro_session=bogus" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await db.insert(sessions).values({ tokenHash: hashToken("old"), userId: user.id, expiresAt: new Date(Date.now() - 1) });
    const app = await buildTestApp(db);

    const response = await call(app, "GET", "/api/me", { cookie: "repro_session=old" });

    expect(response.statusCode).toBe(401);
  });

  it("returns the user and their orgs, never the password hash", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { name: "Ana", email: "ana@example.com", password: "long-password" });
    const org = await createOrgWithOwner(db, user.id, "Acme");
    const app = await buildTestApp(db);

    const response = await call(app, "GET", "/api/me", { cookie: await sessionCookie(db, user.id) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { id: user.id, email: "ana@example.com", name: "Ana", hasPassword: true, githubConnected: false },
      orgs: [{ id: org.id, name: "Acme", role: "owner" }],
    });
    expect(response.body).not.toContain("scrypt");
  });
});
```

Create `server/src/routes/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";

describe("GET /api/auth/config", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("reports signup mode, bootstrap state and GitHub availability", async () => {
    const app = await buildTestApp(getTestDb());
    expect((await call(app, "GET", "/api/auth/config")).json()).toEqual({
      signup: "invite-only",
      bootstrapped: false,
      github: false,
    });

    await createTestUser(getTestDb());
    const configured = await buildTestApp(getTestDb(), {
      signup: "open",
      github: { clientId: "id", clientSecret: "s", baseUrl: "https://github.com" },
    });
    expect((await call(configured, "GET", "/api/auth/config")).json()).toEqual({
      signup: "open",
      bootstrapped: true,
      github: true,
    });
  });
});

describe("POST /api/auth/logout", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes the session and clears the cookie", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const cookie = await sessionCookie(db, user.id);
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/auth/logout", { cookie });

    expect(response.statusCode).toBe(204);
    const cleared = response.cookies.find((c) => c.name === "repro_session");
    expect(cleared?.value).toBe("");
    expect((await call(app, "GET", "/api/me", { cookie })).statusCode).toBe(401);
  });

  it("succeeds without a session", async () => {
    const app = await buildTestApp(getTestDb());
    expect((await call(app, "POST", "/api/auth/logout")).statusCode).toBe(204);
  });
});
```

In `server/src/app.test.ts`, add `import { createTestProject, createTestUser, resetDb, sessionCookie } from "../test/db";` (keeping `getTestDb`) and `import { TEST_ORIGIN, call } from "../test/http";`. Then append:

```ts
describe("CORS scope", () => {
  it("sends no CORS headers on /api routes", async () => {
    const app = await buildApp(getTestDb());
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/me",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

    const get = await app.inject({ method: "GET", url: "/api/auth/config", headers: { origin: "https://evil.example" } });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still allows any origin on /v1/timeline", async () => {
    await resetDb(getTestDb());
    const { key } = await createTestProject(getTestDb());
    const app = await buildApp(getTestDb());
    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { origin: "https://customer.example", "x-repro-key": key },
      payload: {
        sessionId: "s",
        reason: { type: "manual" },
        events: [],
        meta: { url: "https://customer.example", userAgent: "ua", capturedAt: 1 },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["access-control-allow-origin"]).toBe("https://customer.example");
  });
});

describe("CSRF guard", () => {
  it("rejects a mutating /api request without a matching Origin", async () => {
    const app = await buildApp(getTestDb(), { logLevel: "silent" });

    const missing = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: "Cross-origin request blocked" });

    const foreign = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: "https://evil.example" } });
    expect(foreign.statusCode).toBe(403);
  });

  it("rejects a non-JSON body even from the right Origin", async () => {
    const app = await buildApp(getTestDb(), { logLevel: "silent" });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: TEST_ORIGIN, "content-type": "text/plain" },
      payload: "x",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Content-Type must be application/json" });
  });

  it("lets a same-origin request through", async () => {
    await resetDb(getTestDb());
    const user = await createTestUser(getTestDb());
    const app = await buildApp(getTestDb(), { logLevel: "silent" });
    const response = await call(app, "POST", "/api/auth/logout", { cookie: await sessionCookie(getTestDb(), user.id) });
    expect(response.statusCode).toBe(204);
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- src/config.test.ts src/routes src/app.test.ts`
Expected: FAIL. `./config` can't be resolved and the `/api/*` routes return 404.

- [x] **Step 4: Implement the shared pieces**

Create `server/src/config.ts`:

```ts
import { SIGNUP_MODES, type SignupMode } from "./accounts";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** github.com or a GitHub Enterprise Server origin. */
  baseUrl: string;
}

export interface DashboardConfig {
  publicUrl: string;
  signup: SignupMode;
  github?: GithubConfig;
  trustProxy: boolean;
  dashboardDir: string;
}

function parseOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return url.origin;
}

// Throws on invalid values so a misconfigured server fails at startup, not on
// the first login.
export function loadDashboardConfig(env: Record<string, string | undefined>, defaultDashboardDir: string): DashboardConfig {
  const publicUrl = parseOrigin(env.PUBLIC_URL ?? "http://localhost:3000", "PUBLIC_URL");

  const signup = env.SIGNUP ?? "invite-only";
  if (!(SIGNUP_MODES as readonly string[]).includes(signup)) {
    throw new Error('SIGNUP must be "open" or "invite-only"');
  }

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together");
  }
  const github =
    clientId && clientSecret
      ? { clientId, clientSecret, baseUrl: parseOrigin(env.GITHUB_BASE_URL ?? "https://github.com", "GITHUB_BASE_URL") }
      : undefined;

  return {
    publicUrl,
    signup: signup as SignupMode,
    github,
    trustProxy: env.TRUST_PROXY === "true" || env.TRUST_PROXY === "1",
    dashboardDir: env.DASHBOARD_DIR ?? defaultDashboardDir,
  };
}
```

Create `server/src/rate-limit.ts`:

```ts
import type { FastifyRequest } from "fastify";
import type { errorResponseBuilderContext } from "@fastify/rate-limit";

// @fastify/rate-limit throws what this returns, and Fastify reads `.statusCode`
// off it to set the reply status. `statusCode` is defined non-enumerable so it
// drives the status without leaking into the JSON body; app.ts's error handler
// forwards the `{ error }` shape as-is.
export function rateLimitErrorBody(_request: FastifyRequest, context: errorResponseBuilderContext) {
  const body = { error: `Rate limit exceeded, retry in ${context.after}` };
  Object.defineProperty(body, "statusCode", { value: context.statusCode, enumerable: false });
  return body;
}
```

In `server/src/routes/timeline.ts`:
1. Add `import { rateLimitErrorBody } from "../rate-limit";`.
2. Change the route path from `"/v1/timeline"` to `"/timeline"`, and add the comment `// Registered under the /v1 prefix in app.ts.` above `app.post`.
3. Replace the whole `errorResponseBuilder: (_request, context) => { ... },` property with `errorResponseBuilder: rateLimitErrorBody,`.

Create `server/src/routes/context.ts`:

```ts
import type { SignupMode } from "../accounts";
import type { GithubConfig } from "../config";
import type { Database } from "../db/client";

/** What every /api route module needs from the app's configuration. */
export interface ApiContext {
  db: Database;
  /** Origin of the dashboard, e.g. https://app.reprojs.dev — no trailing slash. */
  publicUrl: string;
  secureCookies: boolean;
  signup: SignupMode;
  github?: GithubConfig;
  githubFetch: typeof fetch;
  /** Per-IP login/signup attempts per minute. */
  authRateLimitMax: number;
}
```

Create `server/src/routes/errors.ts`:

```ts
/** An error the global error handler turns into `{ error: message }` with this status. */
export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/** Trims a user/org/project name; a blank one is a 400 with `message`. */
export function requireName(value: string, message: string): string {
  const name = value.trim();
  if (!name) {
    throw httpError(400, message);
  }
  return name;
}
```

Create `server/src/auth/http.ts`:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client";
import type { Membership, Role, User } from "../db/schema";
import { getMembership } from "../db/orgs";
import { createSession, findSessionUser } from "../db/sessions";
import { isUuid } from "../uuid";

export const SESSION_COOKIE = "repro_session";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireUser. */
    user?: User;
    /** The session cookie's token, set by requireUser. */
    sessionToken?: string;
    /** Set by requireMembership. */
    membership?: Membership;
  }
}

export async function startSession(db: Database, reply: FastifyReply, userId: string, secure: boolean): Promise<void> {
  const { token, expiresAt } = await createSession(db, userId);
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", expires: expiresAt });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

// Cookie-authenticated /api routes accept a state-changing request only from
// the dashboard's own origin. Browsers always send Origin on non-GET requests,
// and a cross-site HTML form can't produce an application/json body, so a
// forged request fails one of the two checks. Body-less requests carry no
// Content-Type, since Fastify rejects an empty body declared as JSON.
export function csrfGuard(publicOrigin: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return;
    }
    if (!/^\/api(\/|\?|$)/.test(request.url)) {
      return;
    }
    if (request.headers.origin !== publicOrigin) {
      return reply.code(403).send({ error: "Cross-origin request blocked" });
    }
    const contentType = request.headers["content-type"];
    if (contentType !== undefined && !JSON_CONTENT_TYPE.test(contentType)) {
      return reply.code(403).send({ error: "Content-Type must be application/json" });
    }
  };
}

export function requireUser(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await findSessionUser(db, token) : undefined;
    if (!token || !user) {
      return reply.code(401).send({ error: "Not logged in" });
    }
    request.user = user;
    request.sessionToken = token;
  };
}

// Must run after requireUser. A non-member gets the same 404 as a nonexistent
// org, so org ids can't be probed; a member without the role gets 403.
export function requireMembership(db: Database, minRole: Role) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.params as { orgId?: string };
    const membership = orgId && isUuid(orgId) ? await getMembership(db, orgId, currentUser(request).id) : undefined;
    if (!membership) {
      return reply.code(404).send({ error: "Not Found" });
    }
    if (minRole === "owner" && membership.role !== "owner") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    request.membership = membership;
  };
}

/** The logged-in user. Only valid in handlers behind requireUser. */
export function currentUser(request: FastifyRequest): User {
  if (!request.user) {
    throw new Error("requireUser did not run for this route");
  }
  return request.user;
}

/** The caller's membership of :orgId. Only valid in handlers behind requireMembership. */
export function currentMembership(request: FastifyRequest): Membership {
  if (!request.membership) {
    throw new Error("requireMembership did not run for this route");
  }
  return request.membership;
}
```

Create `server/src/routes/me.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client";
import type { User } from "../db/schema";
import { listUserOrgs, type UserOrg } from "../db/orgs";
import { currentUser, requireUser } from "../auth/http";
import type { ApiContext } from "./context";

export interface MeBody {
  user: { id: string; email: string; name: string; hasPassword: boolean; githubConnected: boolean };
  orgs: UserOrg[];
}

// Also the response body of signup and login, so the SPA can seed its cache.
export async function meBody(db: Database, user: User): Promise<MeBody> {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      hasPassword: user.passwordHash !== null,
      githubConnected: user.githubId !== null,
    },
    orgs: await listUserOrgs(db, user.id),
  };
}

export function registerMeRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get("/api/me", { preValidation: requireUser(db) }, async (request) => meBody(db, currentUser(request)));
}
```

Create `server/src/routes/auth.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, clearSessionCookie } from "../auth/http";
import { deleteSession } from "../db/sessions";
import { countUsers } from "../db/users";
import type { ApiContext } from "./context";

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  // Drives the login/signup UI: whether to offer signup and a GitHub button.
  app.get("/api/auth/config", async () => ({
    signup: ctx.signup,
    bootstrapped: (await countUsers(db)) > 0,
    github: ctx.github !== undefined,
  }));

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(db, token);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
```

- [x] **Step 5: Rewire `app.ts`**

Replace `server/src/app.ts` from the imports down to the end of `buildApp`. Keep the `isPreShapedErrorBody` helper and the error-handler body exactly as they are today; they're reproduced below unchanged.

```ts
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { SignupMode } from "./accounts";
import type { GithubConfig } from "./config";
import type { Database } from "./db/client";
import { csrfGuard } from "./auth/http";
import type { ApiContext } from "./routes/context";
import { registerAuthRoutes } from "./routes/auth";
import { registerMeRoutes } from "./routes/me";
import { registerTimelineRoute } from "./routes/timeline";

export interface AppOptions {
  rateLimitMax?: number;
  rateLimitWindow?: string;
  bodyLimit?: number;
  logLevel?: string;
  /** External URL of the dashboard, e.g. https://app.reprojs.dev. Default http://localhost:3000. */
  publicUrl?: string;
  /** Default "invite-only". */
  signup?: SignupMode;
  /** GitHub login is enabled only when set. */
  github?: GithubConfig;
  /** fetch used for GitHub API calls; tests pass a stub. Default: global fetch. */
  githubFetch?: typeof fetch;
  /** Fastify trustProxy, so rate limits see real client IPs behind a proxy. */
  trustProxy?: boolean;
  /** Built dashboard to serve at /. Not served when unset or missing. */
  dashboardDir?: string;
  /** Per-IP login and signup attempts per minute. Default 10. */
  authRateLimitMax?: number;
  /** Called for every registered route; the tenant-isolation test enumerates routes with it. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

// @fastify/rate-limit's errorResponseBuilder (see rate-limit.ts) throws a plain
// object shaped like `{ error: string }` (with a non-enumerable `statusCode`),
// not an Error. This narrows to that shape so the global error handler can
// forward it as-is instead of reading `.message` off it.
function isPreShapedErrorBody(err: unknown): err is { error: string; statusCode?: number } {
  return typeof err === "object" && err !== null && typeof (err as Record<string, unknown>).error === "string";
}

export async function buildApp(db: Database, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" },
    bodyLimit: options.bodyLimit ?? 256 * 1024,
    trustProxy: options.trustProxy ?? false,
    // Fastify's ajv default silently deletes properties that fail
    // `additionalProperties: false` instead of failing validation. We want
    // unknown fields to be rejected (400), not quietly stripped, so turn
    // that default off globally.
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  if (options.onRoute) {
    const onRoute = options.onRoute;
    app.addHook("onRoute", (route) => onRoute({ method: route.method, url: route.url }));
  }

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Global error shape: every 4xx/5xx response is `{ error: "message" }`.
  //
  // Hooks that reply directly (401s in timeline.ts and auth/http.ts, 403s in
  // csrfGuard) send this shape themselves and never reach this handler.
  //
  // The 429 path is different: @fastify/rate-limit's `errorResponseBuilder`
  // builds `{ error: "..." }` and *throws* it, so it DOES reach this handler.
  // That thrown value is a plain object, not an Error, so it has no
  // `.message`; it's already in the exact final shape we want, just under
  // `.error` instead of `.message`. Detect that shape and forward it as-is.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (isPreShapedErrorBody(err)) {
      reply.code(err.statusCode ?? 500).send({ error: err.error });
      return;
    }

    const statusCode = err.statusCode ?? 500;

    if (statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ error: err.message });
      return;
    }

    // Never leak internal error details (e.g. a raw Postgres error message)
    // to the client on a 500 — log it server-side instead.
    request.log.error(err);
    reply.code(statusCode >= 500 ? statusCode : 500).send({ error: "Internal Server Error" });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "Not Found" });
  });

  const publicUrl = new URL(options.publicUrl ?? "http://localhost:3000").origin;
  app.addHook("onRequest", csrfGuard(publicUrl));

  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Ingest is called cross-origin from customers' sites and authenticates with
  // X-Repro-Key alone, so it gets an open CORS policy. That policy lives in
  // this /v1-prefixed plugin so it never applies to the cookie-authenticated
  // /api routes, which must not be readable cross-origin.
  await app.register(
    async (v1) => {
      await v1.register(cors, {
        origin: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "X-Repro-Key"],
      });
      registerTimelineRoute(v1, db, {
        rateLimitMax: options.rateLimitMax ?? 100,
        rateLimitWindow: options.rateLimitWindow ?? "1 minute",
      });
    },
    { prefix: "/v1" }
  );

  const ctx: ApiContext = {
    db,
    publicUrl,
    secureCookies: publicUrl.startsWith("https:"),
    signup: options.signup ?? "invite-only",
    github: options.github,
    githubFetch: options.githubFetch ?? fetch,
    authRateLimitMax: options.authRateLimitMax ?? 10,
  };
  registerAuthRoutes(app, ctx);
  registerMeRoutes(app, ctx);

  return app;
}
```

In `server/src/index.ts`:
- Add `import path from "node:path";` and `import { loadDashboardConfig } from "./config";`.
- Load the config at the top of `main()`, right after the `DATABASE_URL` check, so a bad value fails before migrating:

```ts
  // dist/index.js → server/dist → repo root → dashboard/dist (same layout in the Docker image).
  const dashboard = loadDashboardConfig(process.env, path.join(__dirname, "..", "..", "dashboard", "dist"));
```

- Pass the config to `buildApp` by adding these properties to its options object:

```ts
    publicUrl: dashboard.publicUrl,
    signup: dashboard.signup,
    github: dashboard.github,
    trustProxy: dashboard.trustProxy,
    dashboardDir: dashboard.dashboardDir,
```

- [x] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server`
Expected: PASS, the whole suite. The existing `/v1/timeline` and CORS tests confirm that the prefix move didn't change ingest. Then run `npm run typecheck -w server && npm run lint -w server`.

- [x] **Step 7: Commit**

```bash
git add package-lock.json server/package.json server/src server/test
git commit -m "feat(server): add cookie sessions, CSRF guard, /v1-scoped CORS, /api/me and logout"
```

---

### Task 7: Signup and login routes

**Files:**
- Modify: `server/src/routes/auth.ts`
- Test: `server/src/routes/auth.test.ts`

**Interfaces:**
- Consumes:
  - `signUp` (Task 5)
  - `hashPassword`, `verifyPasswordOrDummy` (Task 1)
  - `findUserByEmail`, `normalizeEmail` (Task 3)
  - `startSession`, `meBody`, `httpError`, `requireName`, `rateLimitErrorBody`, `ApiContext` (Task 6)
- Produces:
  - `POST /api/auth/signup` `{ email, name, password, inviteToken? }` → `201 MeBody` and sets the session cookie.
  - `POST /api/auth/login` `{ email, password }` → `200 MeBody` and sets the session cookie.
  - `EMAIL_PATTERN`, exported from `routes/auth.ts`.

- [x] **Step 1: Write the failing tests**

Append to `server/src/routes/auth.test.ts`. Extend the imports:
- Add `createTestOrg` to the `../../test/db` import.
- Add `import { addMember } from "../db/orgs";`, `import { createInvite } from "../db/invites";` and `import { findUserByEmail } from "../db/users";`.

```ts
const signupBody = { email: "ana@example.com", name: "Ana", password: "long-password" };

describe("POST /api/auth/signup", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates the account, starts a session, and returns /api/me's body", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });

    const response = await call(app, "POST", "/api/auth/signup", { body: signupBody });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      user: { email: "ana@example.com", name: "Ana", hasPassword: true, githubConnected: false },
      orgs: [{ name: "Ana's org", role: "owner" }],
    });
    const cookie = response.cookies.find((c) => c.name === "repro_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie?.secure).toBeFalsy();
    const me = await call(app, "GET", "/api/me", { cookie: `repro_session=${cookie!.value}` });
    expect(me.statusCode).toBe(200);
  });

  it("marks the cookie Secure when PUBLIC_URL is https", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open", publicUrl: "https://app.example.com" });

    const response = await call(app, "POST", "/api/auth/signup", {
      body: signupBody,
      headers: { origin: "https://app.example.com" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.cookies.find((c) => c.name === "repro_session")?.secure).toBe(true);
  });

  it("normalizes the email and rejects a second signup in another case", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });

    await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, email: "  Ana@Example.COM " } });
    expect(await findUserByEmail(getTestDb(), "ana@example.com")).toBeDefined();

    const again = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, email: "ana@example.com" } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "Email already registered" });
  });

  it("allows the first signup on an invite-only instance, then closes", async () => {
    const app = await buildTestApp(getTestDb());

    expect((await call(app, "POST", "/api/auth/signup", { body: signupBody })).statusCode).toBe(201);

    const second = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, email: "b@example.com" } });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toEqual({ error: "Signup is invite-only" });
  });

  it("accepts an invite token on an invite-only instance and joins only that org", async () => {
    const db = getTestDb();
    const org = await createTestOrg(db, "Acme");
    const owner = await createTestUser(db);
    await addMember(db, org.id, owner.id, "owner");
    const { token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: owner.id });
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, inviteToken: token } });

    expect(response.statusCode).toBe(201);
    expect(response.json().orgs).toEqual([{ id: org.id, name: "Acme", role: "member" }]);
  });

  it("returns 404 for an unusable invite token", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });
    const response = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, inviteToken: "rpi_nope" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Invite not found or expired" });
  });

  it.each([
    [{ ...signupBody, password: "short" }, /password/],
    [{ ...signupBody, email: "not-an-email" }, /^Invalid email$/],
    [{ ...signupBody, name: "   " }, /^Name is required$/],
    [{ ...signupBody, extra: true }, /additional properties/],
  ])("rejects an invalid body %o with 400", async (body, message) => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });
    const response = await call(app, "POST", "/api/auth/signup", { body });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(message);
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("logs in with a differently-cased email and starts a session", async () => {
    const db = getTestDb();
    await createTestUser(db, { email: "ana@example.com", password: "long-password" });
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/auth/login", {
      body: { email: " ANA@example.com", password: "long-password" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe("ana@example.com");
    expect(response.cookies.find((c) => c.name === "repro_session")?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("gives the same 401 for a wrong password, an unknown email, and a GitHub-only account", async () => {
    const db = getTestDb();
    await createTestUser(db, { email: "ana@example.com", password: "long-password" });
    await createTestUser(db, { email: "gh@example.com", githubId: "7" });
    const app = await buildTestApp(db);

    for (const body of [
      { email: "ana@example.com", password: "wrong-password" },
      { email: "nobody@example.com", password: "long-password" },
      { email: "gh@example.com", password: "long-password" },
    ]) {
      const response = await call(app, "POST", "/api/auth/login", { body });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid email or password" });
      expect(response.cookies).toHaveLength(0);
    }
  });

  it("rate-limits login attempts per IP", async () => {
    const app = await buildTestApp(getTestDb(), { authRateLimitMax: 2 });
    const body = { email: "nobody@example.com", password: "whatever-pw" };

    await call(app, "POST", "/api/auth/login", { body });
    await call(app, "POST", "/api/auth/login", { body });
    const third = await call(app, "POST", "/api/auth/login", { body });

    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatch(/^Rate limit exceeded/);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/routes/auth.test.ts`
Expected: FAIL. `/api/auth/signup` and `/api/auth/login` return 404.

- [x] **Step 3: Implement**

Replace `server/src/routes/auth.ts` with:

```ts
import type { FastifyInstance } from "fastify";
import { signUp } from "../accounts";
import { hashPassword, verifyPasswordOrDummy } from "../auth/password";
import { SESSION_COOKIE, clearSessionCookie, startSession } from "../auth/http";
import { deleteSession } from "../db/sessions";
import { countUsers, findUserByEmail, normalizeEmail } from "../db/users";
import { rateLimitErrorBody } from "../rate-limit";
import type { ApiContext } from "./context";
import { httpError, requireName } from "./errors";
import { meBody } from "./me";

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

const passwordSchema = { type: "string", minLength: 8, maxLength: 256 } as const;

const signupSchema = {
  type: "object",
  required: ["email", "name", "password"],
  properties: {
    email: { type: "string", maxLength: 254 },
    name: { type: "string", maxLength: 100 },
    password: passwordSchema,
    inviteToken: { type: "string", maxLength: 100 },
  },
  additionalProperties: false,
} as const;

const loginSchema = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", maxLength: 254 },
    password: { type: "string", maxLength: 256 },
  },
  additionalProperties: false,
} as const;

const SIGNUP_ERRORS = {
  signup_closed: [403, "Signup is invite-only"],
  invite_invalid: [404, "Invite not found or expired"],
  email_taken: [409, "Email already registered"],
  github_taken: [409, "GitHub account already linked"],
} as const;

interface SignupBody {
  email: string;
  name: string;
  password: string;
  inviteToken?: string;
}

interface LoginBody {
  email: string;
  password: string;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const authRateLimit = {
    max: ctx.authRateLimitMax,
    timeWindow: "1 minute",
    errorResponseBuilder: rateLimitErrorBody,
  };

  // Drives the login/signup UI: whether to offer signup and a GitHub button.
  app.get("/api/auth/config", async () => ({
    signup: ctx.signup,
    bootstrapped: (await countUsers(db)) > 0,
    github: ctx.github !== undefined,
  }));

  app.post<{ Body: SignupBody }>(
    "/api/auth/signup",
    { schema: { body: signupSchema }, config: { rateLimit: authRateLimit } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_PATTERN.test(email)) {
        throw httpError(400, "Invalid email");
      }
      const name = requireName(request.body.name, "Name is required");

      const result = await signUp(db, {
        email,
        name,
        passwordHash: await hashPassword(request.body.password),
        githubId: null,
        inviteToken: request.body.inviteToken,
        mode: ctx.signup,
      });
      if (!result.ok) {
        const [status, message] = SIGNUP_ERRORS[result.reason];
        return reply.code(status).send({ error: message });
      }

      await startSession(db, reply, result.user.id, ctx.secureCookies);
      return reply.code(201).send(await meBody(db, result.user));
    }
  );

  app.post<{ Body: LoginBody }>(
    "/api/auth/login",
    { schema: { body: loginSchema }, config: { rateLimit: authRateLimit } },
    async (request, reply) => {
      const user = await findUserByEmail(db, request.body.email);
      // Always one scrypt verification, so timing doesn't reveal whether the
      // email exists or the account is GitHub-only.
      const valid = await verifyPasswordOrDummy(request.body.password, user?.passwordHash ?? null);
      if (!user || !valid) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      await startSession(db, reply, user.id, ctx.secureCookies);
      return meBody(db, user);
    }
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(db, token);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/routes/auth.test.ts`
Expected: PASS. If the `/password/` validation case fails because of a different Ajv message, look at the actual message; it must mention `password`.

- [x] **Step 5: Full suite, typecheck, lint, commit**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`

```bash
git add server/src/routes/auth.ts server/src/routes/auth.test.ts
git commit -m "feat(server): add signup and login routes with per-IP rate limits"
```

---
### Task 8: Org, member and invite routes

**Files:**
- Create: `server/src/routes/orgs.ts`, `server/src/routes/invites.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/routes/orgs.test.ts`, `server/src/routes/invites.test.ts`

**Interfaces:**
- Consumes:
  - `requireUser`, `requireMembership`, `currentUser`, `currentMembership`, `requireName`, `ApiContext` (Task 6)
  - orgs service (Task 4)
  - invites service and `acceptInvite` (Task 5)
  - `isUuid` (Task 2)
- Produces:
  - `server/src/routes/orgs.ts`:
    - `nameBodySchema`: `{ name }`, max 100 characters. Reused by project routes.
    - `registerOrgRoutes(app, ctx)`
  - `server/src/routes/invites.ts`: `registerInviteRoutes(app, ctx)`.
  - Routes and response bodies:
    - `POST /api/orgs` → `201 { id, name, role: "owner" }`
    - `PATCH /api/orgs/:orgId` → `{ id, name }`
    - `GET …/members` → `{ members: Member[] }`
    - `PATCH …/members/:userId` → `{ userId, role }`
    - `DELETE …/members/:userId` → `204`
    - `POST …/invites` → `201 { invite: InviteSummary, link }`
    - `GET …/invites` → `{ invites: InviteSummary[] }`
    - `DELETE …/invites/:inviteId` → `204`
    - `GET /api/invites/:token` → `{ orgName, role }`
    - `POST /api/invites/:token/accept` → `{ orgId }`

- [x] **Step 1: Write the failing tests**

Create `server/src/routes/orgs.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { TEST_ORIGIN, buildTestApp, call } from "../../test/http";
import { addMember, createOrgWithOwner, getMembership } from "../db/orgs";

async function fixture() {
  const db = getTestDb();
  const owner = await createTestUser(db, { name: "Olga", email: "olga@example.com" });
  const member = await createTestUser(db, { name: "Mark", email: "mark@example.com" });
  const org = await createOrgWithOwner(db, owner.id, "Acme");
  await addMember(db, org.id, member.id, "member");
  return {
    db,
    app: await buildTestApp(db),
    org,
    owner,
    member,
    ownerCookie: await sessionCookie(db, owner.id),
    memberCookie: await sessionCookie(db, member.id),
  };
}

describe("org routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("any logged-in user can create an org and becomes its owner", async () => {
    const { app, memberCookie } = await fixture();

    const response = await call(app, "POST", "/api/orgs", { cookie: memberCookie, body: { name: "  Beta  " } });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: expect.any(String), name: "Beta", role: "owner" });
    const me = await call(app, "GET", "/api/me", { cookie: memberCookie });
    expect(me.json().orgs.map((o: { name: string }) => o.name)).toContain("Beta");
  });

  it("rejects a whitespace-only org name", async () => {
    const { app, org, ownerCookie } = await fixture();

    const create = await call(app, "POST", "/api/orgs", { cookie: ownerCookie, body: { name: "   " } });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toEqual({ error: "Org name is required" });

    const rename = await call(app, "PATCH", `/api/orgs/${org.id}`, { cookie: ownerCookie, body: { name: " " } });
    expect(rename.statusCode).toBe(400);
  });

  it("owners rename the org; members get 403", async () => {
    const { app, org, ownerCookie, memberCookie } = await fixture();

    const renamed = await call(app, "PATCH", `/api/orgs/${org.id}`, { cookie: ownerCookie, body: { name: "Acme Inc" } });
    expect(renamed.json()).toEqual({ id: org.id, name: "Acme Inc" });

    const denied = await call(app, "PATCH", `/api/orgs/${org.id}`, { cookie: memberCookie, body: { name: "Nope" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "Forbidden" });
  });

  it("members can list members", async () => {
    const { app, org, owner, member, memberCookie } = await fixture();

    const response = await call(app, "GET", `/api/orgs/${org.id}/members`, { cookie: memberCookie });

    expect(response.statusCode).toBe(200);
    expect(response.json().members).toEqual([
      { userId: owner.id, name: "Olga", email: "olga@example.com", role: "owner", joinedAt: expect.any(String) },
      { userId: member.id, name: "Mark", email: "mark@example.com", role: "member", joinedAt: expect.any(String) },
    ]);
  });

  it("owners change roles; the last owner can't be demoted; members get 403", async () => {
    const { app, db, org, owner, member, ownerCookie, memberCookie } = await fixture();

    const last = await call(app, "PATCH", `/api/orgs/${org.id}/members/${owner.id}`, {
      cookie: ownerCookie,
      body: { role: "member" },
    });
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: "An org must have at least one owner" });

    const denied = await call(app, "PATCH", `/api/orgs/${org.id}/members/${member.id}`, {
      cookie: memberCookie,
      body: { role: "owner" },
    });
    expect(denied.statusCode).toBe(403);

    const promoted = await call(app, "PATCH", `/api/orgs/${org.id}/members/${member.id}`, {
      cookie: ownerCookie,
      body: { role: "owner" },
    });
    expect(promoted.json()).toEqual({ userId: member.id, role: "owner" });
    expect((await getMembership(db, org.id, member.id))?.role).toBe("owner");
  });

  it("rejects an unknown role with 400 and an unknown or malformed user with 404", async () => {
    const { app, db, org, ownerCookie } = await fixture();
    const stranger = await createTestUser(db);

    const badRole = await call(app, "PATCH", `/api/orgs/${org.id}/members/${stranger.id}`, {
      cookie: ownerCookie,
      body: { role: "admin" },
    });
    expect(badRole.statusCode).toBe(400);

    for (const userId of [stranger.id, "not-a-uuid"]) {
      const response = await call(app, "PATCH", `/api/orgs/${org.id}/members/${userId}`, {
        cookie: ownerCookie,
        body: { role: "owner" },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("a removed member loses access on their very next request", async () => {
    const { app, org, member, ownerCookie, memberCookie } = await fixture();
    expect((await call(app, "GET", `/api/orgs/${org.id}/members`, { cookie: memberCookie })).statusCode).toBe(200);

    const removed = await call(app, "DELETE", `/api/orgs/${org.id}/members/${member.id}`, { cookie: ownerCookie });
    expect(removed.statusCode).toBe(204);

    const after = await call(app, "GET", `/api/orgs/${org.id}/members`, { cookie: memberCookie });
    expect(after.statusCode).toBe(404);
  });

  it("members may leave but not remove others; the last owner can't leave", async () => {
    const { app, db, org, owner, member, ownerCookie, memberCookie } = await fixture();

    const removeOther = await call(app, "DELETE", `/api/orgs/${org.id}/members/${owner.id}`, { cookie: memberCookie });
    expect(removeOther.statusCode).toBe(403);

    const ownerLeaves = await call(app, "DELETE", `/api/orgs/${org.id}/members/${owner.id}`, { cookie: ownerCookie });
    expect(ownerLeaves.statusCode).toBe(409);

    const memberLeaves = await call(app, "DELETE", `/api/orgs/${org.id}/members/${member.id}`, { cookie: memberCookie });
    expect(memberLeaves.statusCode).toBe(204);
    expect(await getMembership(db, org.id, member.id)).toBeUndefined();
  });

  it("owners create, list and revoke invites; members get 403", async () => {
    const { app, org, ownerCookie, memberCookie } = await fixture();

    const created = await call(app, "POST", `/api/orgs/${org.id}/invites`, { cookie: ownerCookie, body: { role: "member" } });
    expect(created.statusCode).toBe(201);
    const { invite, link } = created.json();
    expect(link).toMatch(new RegExp(`^${TEST_ORIGIN}/invite/rpi_[A-Za-z0-9_-]{43}$`));
    expect(invite).toEqual({
      id: expect.any(String),
      role: "member",
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      createdByName: "Olga",
    });

    const listed = await call(app, "GET", `/api/orgs/${org.id}/invites`, { cookie: ownerCookie });
    expect(listed.json().invites).toEqual([invite]);

    expect((await call(app, "POST", `/api/orgs/${org.id}/invites`, { cookie: memberCookie, body: { role: "member" } })).statusCode).toBe(403);
    expect((await call(app, "GET", `/api/orgs/${org.id}/invites`, { cookie: memberCookie })).statusCode).toBe(403);
    expect((await call(app, "DELETE", `/api/orgs/${org.id}/invites/${invite.id}`, { cookie: memberCookie })).statusCode).toBe(403);

    expect((await call(app, "DELETE", `/api/orgs/${org.id}/invites/${invite.id}`, { cookie: ownerCookie })).statusCode).toBe(204);
    expect((await call(app, "DELETE", `/api/orgs/${org.id}/invites/${invite.id}`, { cookie: ownerCookie })).statusCode).toBe(404);
    expect((await call(app, "GET", `/api/orgs/${org.id}/invites`, { cookie: ownerCookie })).json().invites).toEqual([]);
  });

  it("returns 401 without a session and 404 for a malformed org id", async () => {
    const { app, org, ownerCookie } = await fixture();
    expect((await call(app, "GET", `/api/orgs/${org.id}/members`)).statusCode).toBe(401);
    expect((await call(app, "GET", `/api/orgs/nope/members`, { cookie: ownerCookie })).statusCode).toBe(404);
  });
});
```

Create `server/src/routes/invites.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { createInvite } from "../db/invites";
import { createOrgWithOwner, getMembership } from "../db/orgs";

async function fixture() {
  const db = getTestDb();
  const owner = await createTestUser(db);
  const org = await createOrgWithOwner(db, owner.id, "Acme");
  const { token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: owner.id });
  return { db, app: await buildTestApp(db), org, owner, token };
}

describe("invite routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("previews a usable invite without logging in", async () => {
    const { app, token } = await fixture();
    const response = await call(app, "GET", `/api/invites/${token}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ orgName: "Acme", role: "member" });
  });

  it("returns 404 for an unknown invite", async () => {
    const { app } = await fixture();
    const response = await call(app, "GET", "/api/invites/rpi_nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Invite not found or expired" });
  });

  it("requires a session to accept", async () => {
    const { app, token } = await fixture();
    expect((await call(app, "POST", `/api/invites/${token}/accept`)).statusCode).toBe(401);
  });

  it("accepts once, then 404s for anyone else", async () => {
    const { app, db, org, token } = await fixture();
    const joiner = await createTestUser(db);
    const latecomer = await createTestUser(db);

    const accepted = await call(app, "POST", `/api/invites/${token}/accept`, { cookie: await sessionCookie(db, joiner.id) });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ orgId: org.id });
    expect((await getMembership(db, org.id, joiner.id))?.role).toBe("member");

    const late = await call(app, "POST", `/api/invites/${token}/accept`, { cookie: await sessionCookie(db, latecomer.id) });
    expect(late.statusCode).toBe(404);
  });

  it("returns 409 for an existing member", async () => {
    const { app, db, owner, token } = await fixture();
    const response = await call(app, "POST", `/api/invites/${token}/accept`, { cookie: await sessionCookie(db, owner.id) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Already a member" });
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/routes/orgs.test.ts src/routes/invites.test.ts`
Expected: FAIL. The routes return 404.

- [x] **Step 3: Implement**

Create `server/src/routes/orgs.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { currentMembership, currentUser, requireMembership, requireUser } from "../auth/http";
import { createInvite, listPendingInvites, revokeInvite } from "../db/invites";
import { changeRole, createOrgWithOwner, listMembers, removeMember, renameOrg, type MembershipChange } from "../db/orgs";
import { ROLES, type Role } from "../db/schema";
import { isUuid } from "../uuid";
import type { ApiContext } from "./context";
import { httpError, requireName } from "./errors";

export const nameBodySchema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string", maxLength: 100 } },
  additionalProperties: false,
} as const;

const roleBodySchema = {
  type: "object",
  required: ["role"],
  properties: { role: { type: "string", enum: [...ROLES] } },
  additionalProperties: false,
} as const;

type OrgParams = { orgId: string };
type MemberParams = { orgId: string; userId: string };

const MEMBERSHIP_ERRORS = {
  not_found: [404, "Not Found"],
  last_owner: [409, "An org must have at least one owner"],
} as const;

function membershipError(result: Extract<MembershipChange, { ok: false }>) {
  const [status, error] = MEMBERSHIP_ERRORS[result.reason];
  return httpError(status, error);
}

export function registerOrgRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const asMember = [requireUser(db), requireMembership(db, "member")];
  const asOwner = [requireUser(db), requireMembership(db, "owner")];

  app.post<{ Body: { name: string } }>(
    "/api/orgs",
    { preValidation: requireUser(db), schema: { body: nameBodySchema } },
    async (request, reply) => {
      const name = requireName(request.body.name, "Org name is required");
      const org = await createOrgWithOwner(db, currentUser(request).id, name);
      return reply.code(201).send({ id: org.id, name: org.name, role: "owner" });
    }
  );

  app.patch<{ Params: OrgParams; Body: { name: string } }>(
    "/api/orgs/:orgId",
    { preValidation: asOwner, schema: { body: nameBodySchema } },
    async (request) => {
      const org = await renameOrg(db, request.params.orgId, requireName(request.body.name, "Org name is required"));
      if (!org) {
        throw httpError(404, "Not Found");
      }
      return { id: org.id, name: org.name };
    }
  );

  app.get<{ Params: OrgParams }>("/api/orgs/:orgId/members", { preValidation: asMember }, async (request) => ({
    members: await listMembers(db, request.params.orgId),
  }));

  app.patch<{ Params: MemberParams; Body: { role: Role } }>(
    "/api/orgs/:orgId/members/:userId",
    { preValidation: asOwner, schema: { body: roleBodySchema } },
    async (request) => {
      const { orgId, userId } = request.params;
      if (!isUuid(userId)) {
        throw httpError(404, "Not Found");
      }
      const result = await changeRole(db, orgId, userId, request.body.role);
      if (!result.ok) {
        throw membershipError(result);
      }
      return { userId, role: request.body.role };
    }
  );

  // Owners remove anyone; a member may only remove themself (leave the org).
  app.delete<{ Params: MemberParams }>(
    "/api/orgs/:orgId/members/:userId",
    { preValidation: asMember },
    async (request, reply) => {
      const { orgId, userId } = request.params;
      if (!isUuid(userId)) {
        throw httpError(404, "Not Found");
      }
      if (userId !== currentUser(request).id && currentMembership(request).role !== "owner") {
        throw httpError(403, "Forbidden");
      }
      const result = await removeMember(db, orgId, userId);
      if (!result.ok) {
        throw membershipError(result);
      }
      return reply.code(204).send();
    }
  );

  app.post<{ Params: OrgParams; Body: { role: Role } }>(
    "/api/orgs/:orgId/invites",
    { preValidation: asOwner, schema: { body: roleBodySchema } },
    async (request, reply) => {
      const { invite, token } = await createInvite(db, {
        orgId: request.params.orgId,
        role: request.body.role,
        createdBy: currentUser(request).id,
      });
      return reply.code(201).send({ invite, link: `${ctx.publicUrl}/invite/${token}` });
    }
  );

  app.get<{ Params: OrgParams }>("/api/orgs/:orgId/invites", { preValidation: asOwner }, async (request) => ({
    invites: await listPendingInvites(db, request.params.orgId),
  }));

  app.delete<{ Params: OrgParams & { inviteId: string } }>(
    "/api/orgs/:orgId/invites/:inviteId",
    { preValidation: asOwner },
    async (request, reply) => {
      const { orgId, inviteId } = request.params;
      if (!isUuid(inviteId) || !(await revokeInvite(db, orgId, inviteId))) {
        throw httpError(404, "Not Found");
      }
      return reply.code(204).send();
    }
  );
}
```

Create `server/src/routes/invites.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { acceptInvite } from "../accounts";
import { currentUser, requireUser } from "../auth/http";
import { findUsableInvite } from "../db/invites";
import type { ApiContext } from "./context";
import { httpError } from "./errors";

// Used, revoked and expired invites all get this, so the response doesn't say which.
const INVITE_NOT_FOUND = "Invite not found or expired";

type TokenParams = { token: string };

export function registerInviteRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  // Public, so the invite page can show "Join <org>" before the visitor logs in.
  app.get<{ Params: TokenParams }>("/api/invites/:token", async (request) => {
    const invite = await findUsableInvite(db, request.params.token);
    if (!invite) {
      throw httpError(404, INVITE_NOT_FOUND);
    }
    return { orgName: invite.orgName, role: invite.role };
  });

  app.post<{ Params: TokenParams }>(
    "/api/invites/:token/accept",
    { preValidation: requireUser(db) },
    async (request) => {
      const result = await acceptInvite(db, request.params.token, currentUser(request).id);
      if (!result.ok) {
        throw result.reason === "already_member" ? httpError(409, "Already a member") : httpError(404, INVITE_NOT_FOUND);
      }
      return { orgId: result.orgId };
    }
  );
}
```

In `server/src/app.ts`, add these imports:

```ts
import { registerInviteRoutes } from "./routes/invites";
import { registerOrgRoutes } from "./routes/orgs";
```

After `registerMeRoutes(app, ctx);`, add:

```ts
  registerOrgRoutes(app, ctx);
  registerInviteRoutes(app, ctx);
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/routes`
Expected: PASS.

- [x] **Step 5: Full suite, typecheck, lint, commit**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`

```bash
git add server/src/app.ts server/src/routes
git commit -m "feat(server): add org, member and invite routes"
```

---

### Task 9: Project and key routes, plus the tenant-isolation test

**Files:**
- Create: `server/src/routes/projects.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/routes/projects.test.ts`, `server/src/routes/isolation.test.ts`

**Interfaces:**
- Consumes:
  - `createProject`, `listProjects`, `findProjectInOrg`, `findApiKeyInOrg`, `createApiKey`, `listApiKeys`, `revokeApiKey` (Task 2 and the existing key service)
  - `nameBodySchema` (Task 8)
  - the auth hooks (Task 6)
- Produces: `registerProjectRoutes(app, ctx)` and these routes:
  - `GET …/projects` → `{ projects: ProjectSummary[] }`
  - `POST …/projects` → `201 { project, key }`
  - `GET …/projects/:projectId/keys` → `{ keys: ApiKeySummary[] }`
  - `POST …/projects/:projectId/keys` → `201 { apiKey, key }`
  - `POST …/keys/:keyId/revoke` → `{ apiKey, alreadyRevoked }`

- [x] **Step 1: Write the failing tests**

Create `server/src/routes/projects.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { addMember, createOrgWithOwner } from "../db/orgs";

const timeline = {
  sessionId: "s",
  reason: { type: "manual" },
  events: [],
  meta: { url: "https://example.com", userAgent: "ua", capturedAt: 1 },
};

async function fixture() {
  const db = getTestDb();
  const user = await createTestUser(db);
  const org = await createOrgWithOwner(db, user.id, "Acme");
  const member = await createTestUser(db);
  await addMember(db, org.id, member.id, "member");
  return { db, app: await buildTestApp(db), org, cookie: await sessionCookie(db, member.id) };
}

function ingest(app: Awaited<ReturnType<typeof buildTestApp>>, key: string) {
  return app.inject({ method: "POST", url: "/v1/timeline", headers: { "x-repro-key": key }, payload: timeline });
}

describe("project routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("a member creates a project and gets a working key once", async () => {
    const { app, org, cookie } = await fixture();

    const response = await call(app, "POST", `/api/orgs/${org.id}/projects`, { cookie, body: { name: " web " } });

    expect(response.statusCode).toBe(201);
    const { project, key } = response.json();
    expect(project).toMatchObject({ orgId: org.id, name: "web" });
    expect(key).toMatch(/^rpk_/);
    expect((await ingest(app, key)).statusCode).toBe(201);
  });

  it("rejects a whitespace-only project name", async () => {
    const { app, org, cookie } = await fixture();
    const response = await call(app, "POST", `/api/orgs/${org.id}/projects`, { cookie, body: { name: "  " } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Project name is required" });
  });

  it("lists only the org's projects", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project } = await createTestProject(db, "mine", org.id);
    await createTestProject(db, "someone else's");

    const response = await call(app, "GET", `/api/orgs/${org.id}/projects`, { cookie });

    expect(response.json().projects).toEqual([
      { id: project.id, orgId: org.id, name: "mine", createdAt: expect.any(String), activeKeyCount: 1 },
    ]);
  });

  it("lists keys without hashes, mints more, and revokes idempotently", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project, key: firstKey } = await createTestProject(db, "web", org.id);
    const base = `/api/orgs/${org.id}/projects/${project.id}/keys`;

    const minted = await call(app, "POST", base, { cookie });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().key).toMatch(/^rpk_/);

    const listed = await call(app, "GET", base, { cookie });
    expect(listed.json().keys).toHaveLength(2);
    expect(listed.body).not.toContain("keyHash");
    expect(listed.body).not.toContain(firstKey);

    const firstId = listed.json().keys[0].id;
    const revoked = await call(app, "POST", `${base}/${firstId}/revoke`, { cookie });
    expect(revoked.json()).toMatchObject({ alreadyRevoked: false, apiKey: { id: firstId } });
    expect((await ingest(app, firstKey)).statusCode).toBe(401);

    const again = await call(app, "POST", `${base}/${firstId}/revoke`, { cookie });
    expect(again.json().alreadyRevoked).toBe(true);
  });

  it("won't revoke a key through a different project of the same org", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project: web } = await createTestProject(db, "web", org.id);
    const { project: api, key: apiKey } = await createTestProject(db, "api", org.id);
    const [apiKeyRow] = (await call(app, "GET", `/api/orgs/${org.id}/projects/${api.id}/keys`, { cookie })).json().keys;

    const response = await call(app, "POST", `/api/orgs/${org.id}/projects/${web.id}/keys/${apiKeyRow.id}/revoke`, {
      cookie,
    });

    expect(response.statusCode).toBe(404);
    expect((await ingest(app, apiKey)).statusCode).toBe(201);
  });

  it("returns 404 for unknown and malformed project and key ids", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project } = await createTestProject(db, "web", org.id);
    const missing = "00000000-0000-0000-0000-000000000000";

    for (const url of [
      `/api/orgs/${org.id}/projects/${missing}/keys`,
      `/api/orgs/${org.id}/projects/nope/keys`,
    ]) {
      expect((await call(app, "GET", url, { cookie })).statusCode).toBe(404);
      expect((await call(app, "POST", url, { cookie })).statusCode).toBe(404);
    }
    for (const keyId of [missing, "nope"]) {
      const url = `/api/orgs/${org.id}/projects/${project.id}/keys/${keyId}/revoke`;
      expect((await call(app, "POST", url, { cookie })).statusCode).toBe(404);
    }
  });
});
```

Create `server/src/routes/isolation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { createInvite, listPendingInvites } from "../db/invites";
import { addMember, createOrgWithOwner, getMembership } from "../db/orgs";
import { listApiKeys, listProjects } from "../db/projects";
import { orgs } from "../db/schema";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Fixture {
  orgId: string;
  memberId: string;
  projectId: string;
  keyId: string;
  inviteId: string;
}

interface RouteCase {
  /** Fastify's route pattern — must match the registered route exactly. */
  route: string;
  url: (f: Fixture) => string;
  body?: unknown;
}

// Every org-scoped route, in an order where the owner's positive-control run
// doesn't delete something a later case needs (the member is removed last).
const CASES: RouteCase[] = [
  { route: "PATCH /api/orgs/:orgId", url: (f) => `/api/orgs/${f.orgId}`, body: { name: "Hijacked" } },
  { route: "GET /api/orgs/:orgId/members", url: (f) => `/api/orgs/${f.orgId}/members` },
  {
    route: "PATCH /api/orgs/:orgId/members/:userId",
    url: (f) => `/api/orgs/${f.orgId}/members/${f.memberId}`,
    body: { role: "owner" },
  },
  { route: "GET /api/orgs/:orgId/invites", url: (f) => `/api/orgs/${f.orgId}/invites` },
  { route: "POST /api/orgs/:orgId/invites", url: (f) => `/api/orgs/${f.orgId}/invites`, body: { role: "owner" } },
  { route: "DELETE /api/orgs/:orgId/invites/:inviteId", url: (f) => `/api/orgs/${f.orgId}/invites/${f.inviteId}` },
  { route: "GET /api/orgs/:orgId/projects", url: (f) => `/api/orgs/${f.orgId}/projects` },
  { route: "POST /api/orgs/:orgId/projects", url: (f) => `/api/orgs/${f.orgId}/projects`, body: { name: "x" } },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/keys",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/keys`,
  },
  {
    route: "POST /api/orgs/:orgId/projects/:projectId/keys",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/keys`,
  },
  {
    route: "POST /api/orgs/:orgId/projects/:projectId/keys/:keyId/revoke",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/keys/${f.keyId}/revoke`,
  },
  { route: "DELETE /api/orgs/:orgId/members/:userId", url: (f) => `/api/orgs/${f.orgId}/members/${f.memberId}` },
];

function methodOf(route: string): Method {
  return route.split(" ")[0] as Method;
}

async function setup() {
  const db = getTestDb();
  const owner = await createTestUser(db);
  const member = await createTestUser(db);
  const org = await createOrgWithOwner(db, owner.id, "Victim");
  await addMember(db, org.id, member.id, "member");
  const { project } = await createTestProject(db, "web", org.id);
  const [key] = await listApiKeys(db, project.id);
  const { invite } = await createInvite(db, { orgId: org.id, role: "member", createdBy: owner.id });

  const outsider = await createTestUser(db);
  const outsiderOrg = await createOrgWithOwner(db, outsider.id, "Attacker");

  const victim: Fixture = { orgId: org.id, memberId: member.id, projectId: project.id, keyId: key.id, inviteId: invite.id };
  return {
    db,
    victim,
    ownerCookie: await sessionCookie(db, owner.id),
    outsiderCookie: await sessionCookie(db, outsider.id),
    outsiderOrgId: outsiderOrg.id,
  };
}

async function expectVictimUntouched(db: ReturnType<typeof getTestDb>, victim: Fixture) {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, victim.orgId));
  expect(org.name).toBe("Victim");
  expect((await getMembership(db, victim.orgId, victim.memberId))?.role).toBe("member");
  expect((await listApiKeys(db, victim.projectId))[0].revokedAt).toBeNull();
  expect(await listApiKeys(db, victim.projectId)).toHaveLength(1);
  expect(await listProjects(db, { orgId: victim.orgId })).toHaveLength(1);
  expect((await listPendingInvites(db, victim.orgId)).map((i) => i.id)).toEqual([victim.inviteId]);
}

describe("tenant isolation", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("covers every registered org-scoped route", async () => {
    const registered: string[] = [];
    await buildTestApp(getTestDb(), {
      onRoute: ({ method, url }) => {
        for (const m of [method].flat()) {
          if (m !== "HEAD" && url.startsWith("/api/orgs/:orgId")) {
            registered.push(`${m} ${url}`);
          }
        }
      },
    });

    expect(registered.sort()).toEqual(CASES.map((c) => c.route).sort());
  });

  it("a user from another org gets 404 on every org-scoped route and changes nothing", async () => {
    const { db, victim, outsiderCookie } = await setup();
    const app = await buildTestApp(db);

    for (const c of CASES) {
      const response = await call(app, methodOf(c.route), c.url(victim), { cookie: outsiderCookie, body: c.body });
      expect({ route: c.route, status: response.statusCode, body: response.json() }).toEqual({
        route: c.route,
        status: 404,
        body: { error: "Not Found" },
      });
    }
    await expectVictimUntouched(db, victim);
  });

  it("a user can't reach another org's resources through their own org id", async () => {
    const { db, victim, outsiderCookie, outsiderOrgId } = await setup();
    const app = await buildTestApp(db);
    const crossed: Fixture = { ...victim, orgId: outsiderOrgId };

    for (const c of CASES.filter((c) => c.route.split("/").length > 5)) {
      const response = await call(app, methodOf(c.route), c.url(crossed), { cookie: outsiderCookie, body: c.body });
      expect({ route: c.route, status: response.statusCode }).toEqual({ route: c.route, status: 404 });
    }
    await expectVictimUntouched(db, victim);
  });

  it("the org's owner can reach every route (so the 404s above mean something)", async () => {
    const { db, victim, ownerCookie } = await setup();
    const app = await buildTestApp(db);

    for (const c of CASES) {
      const response = await call(app, methodOf(c.route), c.url(victim), { cookie: ownerCookie, body: c.body });
      expect({ route: c.route, status: response.statusCode }).not.toEqual({ route: c.route, status: 404 });
    }
  });
});
```

In the cross-org test, `split("/").length > 5` selects the routes that have a nested id after `:orgId`, such as `/api/orgs/:orgId/members/:userId` and the project routes. Org-level routes like `/api/orgs/:orgId/projects` are excluded, because through the outsider's own org id they are legitimately reachable.

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/routes/projects.test.ts src/routes/isolation.test.ts`
Expected: FAIL. The project routes return 404 for the owner, and the coverage test lists the missing project routes.

- [x] **Step 3: Implement**

Create `server/src/routes/projects.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { requireMembership, requireUser } from "../auth/http";
import {
  createApiKey,
  createProject,
  findApiKeyInOrg,
  findProjectInOrg,
  listApiKeys,
  listProjects,
  revokeApiKey,
} from "../db/projects";
import { isUuid } from "../uuid";
import type { ApiContext } from "./context";
import { httpError, requireName } from "./errors";
import { nameBodySchema } from "./orgs";

type OrgParams = { orgId: string };
type ProjectParams = OrgParams & { projectId: string };
type KeyParams = ProjectParams & { keyId: string };

// Key logic lives in db/projects.ts (shared with the CLI). These routes only add
// the tenant check: every project and key is looked up through :orgId first.
export function registerProjectRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const asMember = [requireUser(db), requireMembership(db, "member")];

  async function requireProject({ orgId, projectId }: ProjectParams): Promise<void> {
    if (!isUuid(projectId) || !(await findProjectInOrg(db, orgId, projectId))) {
      throw httpError(404, "Not Found");
    }
  }

  app.get<{ Params: OrgParams }>("/api/orgs/:orgId/projects", { preValidation: asMember }, async (request) => ({
    projects: await listProjects(db, { orgId: request.params.orgId }),
  }));

  app.post<{ Params: OrgParams; Body: { name: string } }>(
    "/api/orgs/:orgId/projects",
    { preValidation: asMember, schema: { body: nameBodySchema } },
    async (request, reply) => {
      const name = requireName(request.body.name, "Project name is required");
      return reply.code(201).send(await createProject(db, request.params.orgId, name));
    }
  );

  app.get<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys",
    { preValidation: asMember },
    async (request) => {
      await requireProject(request.params);
      return { keys: await listApiKeys(db, request.params.projectId) };
    }
  );

  app.post<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys",
    { preValidation: asMember },
    async (request, reply) => {
      await requireProject(request.params);
      const created = await createApiKey(db, request.params.projectId);
      if (!created) {
        throw httpError(404, "Not Found");
      }
      return reply.code(201).send(created);
    }
  );

  app.post<{ Params: KeyParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys/:keyId/revoke",
    { preValidation: asMember },
    async (request) => {
      const { orgId, projectId, keyId } = request.params;
      const found = isUuid(projectId) && isUuid(keyId) ? await findApiKeyInOrg(db, orgId, projectId, keyId) : undefined;
      const result = found ? await revokeApiKey(db, keyId) : undefined;
      if (!result) {
        throw httpError(404, "Not Found");
      }
      return result;
    }
  );
}
```

In `server/src/app.ts`, add `import { registerProjectRoutes } from "./routes/projects";` and, after `registerInviteRoutes(app, ctx);`, add `registerProjectRoutes(app, ctx);`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/routes`
Expected: PASS.

- [x] **Step 5: Full suite, typecheck, lint, commit**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`

```bash
git add server/src/app.ts server/src/routes
git commit -m "feat(server): add org-scoped project and key routes with a tenant-isolation test"
```

---

### Task 10: Account settings and GitHub OAuth

**Files:**
- Create: `server/src/auth/github.ts`, `server/src/routes/github.ts`
- Modify: `server/src/routes/me.ts`, `server/src/app.ts`
- Test: `server/src/auth/github.test.ts`, `server/src/routes/github.test.ts` (create); `server/src/routes/me.test.ts` (modify)

**Interfaces:**
- Consumes:
  - `GithubConfig`, `ApiContext`, `startSession`, `SESSION_COOKIE` (Task 6)
  - `signUp` (Task 5)
  - the users and sessions services (Task 3)
  - `generateToken` (Task 1)
- Produces:
  - `server/src/auth/github.ts`:
    - `interface GithubProfile { id: string; login: string; name: string | null; email: string | null }`, where `email` is the verified primary email or `null`.
    - `githubApiBase(baseUrl: string): string`
    - `githubAuthorizeUrl(config, state, redirectUri): string`
    - `fetchGithubProfile(config, code, redirectUri, fetchImpl): Promise<GithubProfile>`, which throws `GithubError`.
  - Routes:
    - `GET /api/auth/github?intent=login|connect[&invite=]`
    - `GET /api/auth/github/callback`
    - `POST /api/me/password`
    - `DELETE /api/me/github`
  - Redirect error codes, which the SPA maps to messages in Tasks 12 and 14:
    - `/login?error=`: `github_state`, `github_failed`, `github_no_email`, `github_email_exists`, `signup_closed`, `invite_invalid`, `not_logged_in`
    - `/settings?error=`: `github_taken`, `github_failed`

- [ ] **Step 1: Write the failing tests**

Create `server/src/auth/github.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fetchGithubProfile, githubApiBase, githubAuthorizeUrl, GithubError } from "./github";

const config = { clientId: "cid", clientSecret: "secret", baseUrl: "https://github.com" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("github helpers", () => {
  it("derives the API base for github.com and GitHub Enterprise Server", () => {
    expect(githubApiBase("https://github.com")).toBe("https://api.github.com");
    expect(githubApiBase("https://ghe.example.com")).toBe("https://ghe.example.com/api/v3");
  });

  it("builds the authorize URL", () => {
    const url = new URL(githubAuthorizeUrl(config, "st4te", "http://localhost:3000/api/auth/github/callback"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "http://localhost:3000/api/auth/github/callback",
      scope: "read:user user:email",
      state: "st4te",
    });
  });

  it("exchanges the code and returns the profile with the verified primary email", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "gho_x" });
      if (url === "https://api.github.com/user") return json({ id: 42, login: "ana", name: "Ana" });
      return json([
        { email: "old@example.com", primary: false, verified: true },
        { email: "Ana@Example.com", primary: true, verified: true },
      ]);
    }) as typeof fetch;

    const profile = await fetchGithubProfile(config, "code", "http://cb", fetchImpl);

    expect(profile).toEqual({ id: "42", login: "ana", name: "Ana", email: "Ana@Example.com" });
    expect(calls).toContain("https://api.github.com/user/emails");
  });

  it("returns a null email when the primary email is unverified", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("access_token")) return json({ access_token: "gho_x" });
      if (url.endsWith("/user")) return json({ id: 1, login: "x", name: null });
      return json([{ email: "x@example.com", primary: true, verified: false }]);
    }) as typeof fetch;

    expect((await fetchGithubProfile(config, "code", "http://cb", fetchImpl)).email).toBeNull();
  });

  it("throws GithubError when the token exchange fails", async () => {
    const fetchImpl = (async () => json({ error: "bad_verification_code" })) as typeof fetch;
    await expect(fetchGithubProfile(config, "code", "http://cb", fetchImpl)).rejects.toBeInstanceOf(GithubError);
  });
});
```

Create `server/src/routes/github.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestOrg, createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { TEST_ORIGIN, buildTestApp, call } from "../../test/http";
import { createInvite } from "../db/invites";
import { addMember, listUserOrgs } from "../db/orgs";
import { findUserByEmail, findUserByGithubId, findUserById } from "../db/users";
import type { AppOptions } from "../app";

const GITHUB = { clientId: "cid", clientSecret: "secret", baseUrl: "https://github.com" };

interface FakeGithubUser {
  id: number;
  login: string;
  name: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
  tokenFails?: boolean;
}

function fakeGithub(user: FakeGithubUser): typeof fetch {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return json(user.tokenFails ? { error: "bad_verification_code" } : { access_token: "gho_test" });
    }
    if (url === "https://api.github.com/user") return json({ id: user.id, login: user.login, name: user.name });
    if (url === "https://api.github.com/user/emails") return json(user.emails);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

const ANA: FakeGithubUser = {
  id: 42,
  login: "ana",
  name: "Ana",
  emails: [{ email: "ana@example.com", primary: true, verified: true }],
};

async function githubApp(user: FakeGithubUser, options: AppOptions = {}) {
  return buildTestApp(getTestDb(), { github: GITHUB, githubFetch: fakeGithub(user), ...options });
}

// Runs the whole round trip: start → (GitHub) → callback. Returns the callback response.
async function oauthRoundTrip(app: FastifyInstance, query = "intent=login", cookie?: string) {
  const start = await call(app, "GET", `/api/auth/github?${query}`, { cookie });
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get("state");
  const oauth = start.cookies.find((c) => c.name === "repro_oauth");
  const cookies = [`repro_oauth=${oauth!.value}`, cookie].filter(Boolean).join("; ");
  return call(app, "GET", `/api/auth/github/callback?code=abc&state=${state}`, { cookie: cookies });
}

describe("GitHub OAuth", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("is 404 when GitHub isn't configured", async () => {
    const app = await buildTestApp(getTestDb());
    expect((await call(app, "GET", "/api/auth/github?intent=login")).statusCode).toBe(404);
  });

  it("redirects to GitHub with a state bound to an httpOnly cookie", async () => {
    const app = await githubApp(ANA);
    const response = await call(app, "GET", "/api/auth/github?intent=login");

    const location = new URL(response.headers.location as string);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("redirect_uri")).toBe(`${TEST_ORIGIN}/api/auth/github/callback`);
    const oauth = response.cookies.find((c) => c.name === "repro_oauth");
    expect(oauth).toMatchObject({ httpOnly: true, path: "/api/auth/github" });
    expect(oauth!.value.startsWith(location.searchParams.get("state")!)).toBe(true);
  });

  it("signs up a new user with no password and logs them in", async () => {
    const app = await githubApp(ANA, { signup: "open" });

    const response = await oauthRoundTrip(app);

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(response.cookies.find((c) => c.name === "repro_session")?.value).toBeTruthy();
    const user = await findUserByGithubId(getTestDb(), "42");
    expect(user).toMatchObject({ email: "ana@example.com", name: "Ana", passwordHash: null });
    expect((await listUserOrgs(getTestDb(), user!.id)).map((o) => o.name)).toEqual(["Ana's org"]);
  });

  it("logs in an already-linked user without creating anyone", async () => {
    const existing = await createTestUser(getTestDb(), { email: "other@example.com", githubId: "42" });
    const app = await githubApp(ANA);

    const response = await oauthRoundTrip(app);

    expect(response.headers.location).toBe("/");
    expect(response.cookies.find((c) => c.name === "repro_session")).toBeDefined();
    expect(await findUserByEmail(getTestDb(), "ana@example.com")).toBeUndefined();
    expect((await findUserById(getTestDb(), existing.id))?.githubId).toBe("42");
  });

  it("refuses to auto-link to a password account with the same email", async () => {
    const existing = await createTestUser(getTestDb(), { email: "ana@example.com" });
    const app = await githubApp(ANA, { signup: "open" });

    const response = await oauthRoundTrip(app);

    expect(response.headers.location).toBe("/login?error=github_email_exists");
    expect((await findUserById(getTestDb(), existing.id))?.githubId).toBeNull();
  });

  it("refuses a GitHub account without a verified primary email", async () => {
    const app = await githubApp(
      { ...ANA, emails: [{ email: "ana@example.com", primary: true, verified: false }] },
      { signup: "open" }
    );
    expect((await oauthRoundTrip(app)).headers.location).toBe("/login?error=github_no_email");
  });

  it("rejects a callback whose state doesn't match the cookie", async () => {
    const app = await githubApp(ANA);
    const response = await call(app, "GET", "/api/auth/github/callback?code=abc&state=forged", {
      cookie: "repro_oauth=real.login.",
    });
    expect(response.headers.location).toBe("/login?error=github_state");
  });

  it("reports a failed token exchange", async () => {
    const app = await githubApp({ ...ANA, tokenFails: true });
    expect((await oauthRoundTrip(app)).headers.location).toBe("/login?error=github_failed");
  });

  it("applies invite-only signup rules, and honors an invite", async () => {
    await createTestUser(getTestDb()); // instance already bootstrapped
    const app = await githubApp(ANA);
    expect((await oauthRoundTrip(app)).headers.location).toBe("/login?error=signup_closed");

    const org = await createTestOrg(getTestDb(), "Acme");
    const owner = await createTestUser(getTestDb());
    await addMember(getTestDb(), org.id, owner.id, "owner");
    const { token } = await createInvite(getTestDb(), { orgId: org.id, role: "member", createdBy: owner.id });

    const response = await oauthRoundTrip(app, `intent=login&invite=${token}`);

    expect(response.headers.location).toBe("/");
    const user = await findUserByGithubId(getTestDb(), "42");
    expect(await listUserOrgs(getTestDb(), user!.id)).toEqual([{ id: org.id, name: "Acme", role: "member" }]);
  });

  it("connects GitHub to the logged-in user", async () => {
    const user = await createTestUser(getTestDb(), { email: "someone@example.com" });
    const app = await githubApp(ANA);

    const response = await oauthRoundTrip(app, "intent=connect", await sessionCookie(getTestDb(), user.id));

    expect(response.headers.location).toBe("/settings");
    expect((await findUserById(getTestDb(), user.id))?.githubId).toBe("42");
  });

  it("won't connect a GitHub account that belongs to another user", async () => {
    await createTestUser(getTestDb(), { githubId: "42" });
    const user = await createTestUser(getTestDb());
    const app = await githubApp(ANA);

    const response = await oauthRoundTrip(app, "intent=connect", await sessionCookie(getTestDb(), user.id));

    expect(response.headers.location).toBe("/settings?error=github_taken");
    expect((await findUserById(getTestDb(), user.id))?.githubId).toBeNull();
  });

  it("sends a logged-out connect attempt to the login page", async () => {
    const app = await githubApp(ANA);
    expect((await oauthRoundTrip(app, "intent=connect")).headers.location).toBe("/login?error=not_logged_in");
  });
});
```

Append to `server/src/routes/me.test.ts`. Extend the imports:
- Add `import { createSession, findSessionUser } from "../db/sessions";` and `import { findUserById } from "../db/users";`.
- Add `import { verifyPassword } from "../auth/password";`.

```ts
describe("POST /api/me/password", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("changes the password and logs out every other session", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { password: "old-password" });
    const current = await createSession(db, user.id);
    const other = await createSession(db, user.id);
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/me/password", {
      cookie: `repro_session=${current.token}`,
      body: { currentPassword: "old-password", newPassword: "new-password" },
    });

    expect(response.statusCode).toBe(204);
    const updated = await findUserById(db, user.id);
    expect(await verifyPassword("new-password", updated!.passwordHash!)).toBe(true);
    expect(await findSessionUser(db, current.token)).toBeDefined();
    expect(await findSessionUser(db, other.token)).toBeUndefined();
  });

  it("requires the correct current password", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { password: "old-password" });
    const app = await buildTestApp(db);
    const cookie = await sessionCookie(db, user.id);

    for (const body of [{ currentPassword: "wrong-password", newPassword: "new-password" }, { newPassword: "new-password" }]) {
      const response = await call(app, "POST", "/api/me/password", { cookie, body });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Current password is incorrect" });
    }
  });

  it("lets a GitHub-only user set a first password", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "9" });
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/me/password", {
      cookie: await sessionCookie(db, user.id),
      body: { newPassword: "first-password" },
    });

    expect(response.statusCode).toBe(204);
    expect((await findUserById(db, user.id))?.passwordHash).toMatch(/^scrypt\$/);
  });
});

describe("DELETE /api/me/github", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("disconnects GitHub when the user has a password", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "9", password: "a-password" });
    const app = await buildTestApp(db);

    const response = await call(app, "DELETE", "/api/me/github", { cookie: await sessionCookie(db, user.id) });

    expect(response.statusCode).toBe(204);
    expect((await findUserById(db, user.id))?.githubId).toBeNull();
  });

  it("refuses when it would leave no way to log in", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "9" });
    const app = await buildTestApp(db);

    const response = await call(app, "DELETE", "/api/me/github", { cookie: await sessionCookie(db, user.id) });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Set a password before disconnecting GitHub" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/auth/github.test.ts src/routes/github.test.ts src/routes/me.test.ts`
Expected: FAIL. `./github` can't be resolved and the routes return 404.

- [ ] **Step 3: Implement**

Create `server/src/auth/github.ts`:

```ts
import type { GithubConfig } from "../config";

export interface GithubProfile {
  /** GitHub's numeric user id, as text. */
  id: string;
  login: string;
  name: string | null;
  /** The verified primary email, or null if GitHub has none verified. */
  email: string | null;
}

export class GithubError extends Error {}

export function githubApiBase(baseUrl: string): string {
  return baseUrl === "https://github.com" ? "https://api.github.com" : `${baseUrl}/api/v3`;
}

export function githubAuthorizeUrl(config: GithubConfig, state: string, redirectUri: string): string {
  const url = new URL("/login/oauth/authorize", config.baseUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state,
  }).toString();
  return url.toString();
}

export async function fetchGithubProfile(
  config: GithubConfig,
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch
): Promise<GithubProfile> {
  const tokenResponse = await fetchImpl(new URL("/login/oauth/access_token", config.baseUrl).toString(), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  // GitHub reports a bad code as 200 with `{ error }`, so check the body too.
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new GithubError("GitHub token exchange failed");
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${tokenBody.access_token}`,
    "User-Agent": "repro",
  };
  const api = githubApiBase(config.baseUrl);
  const [userResponse, emailsResponse] = await Promise.all([
    fetchImpl(`${api}/user`, { headers }),
    fetchImpl(`${api}/user/emails`, { headers }),
  ]);
  if (!userResponse.ok || !emailsResponse.ok) {
    throw new GithubError("GitHub API request failed");
  }
  const user = (await userResponse.json()) as { id: number; login: string; name: string | null };
  const emails = (await emailsResponse.json()) as { email: string; primary: boolean; verified: boolean }[];
  const primary = emails.find((e) => e.primary && e.verified);
  return { id: String(user.id), login: user.login, name: user.name, email: primary?.email ?? null };
}
```

Create `server/src/routes/github.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { signUp, type SignUpResult } from "../accounts";
import { SESSION_COOKIE, startSession } from "../auth/http";
import { fetchGithubProfile, githubAuthorizeUrl, type GithubProfile } from "../auth/github";
import { generateToken } from "../auth/tokens";
import { findSessionUser } from "../db/sessions";
import { findUserByEmail, findUserByGithubId, setGithubId } from "../db/users";
import type { ApiContext } from "./context";

const OAUTH_COOKIE = "repro_oauth";
// Scoped so the cookie only travels to the start and callback routes.
const OAUTH_COOKIE_PATH = "/api/auth/github";

type Intent = "login" | "connect";

const SIGNUP_REDIRECTS: Record<Extract<SignUpResult, { ok: false }>["reason"], string> = {
  signup_closed: "/login?error=signup_closed",
  invite_invalid: "/login?error=invite_invalid",
  email_taken: "/login?error=github_email_exists",
  github_taken: "/login?error=github_failed",
};

// Every outcome is a redirect into the SPA, which maps `error` codes to messages.
export function registerGithubRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const redirectUri = `${ctx.publicUrl}/api/auth/github/callback`;

  app.get<{ Querystring: { intent?: string; invite?: string } }>("/api/auth/github", async (request, reply) => {
    if (!ctx.github) {
      return reply.code(404).send({ error: "Not Found" });
    }
    const intent: Intent = request.query.intent === "connect" ? "connect" : "login";
    const invite = request.query.invite ?? "";
    // The cookie value is `state.intent.invite`; tokens are base64url, so no dots.
    if (!/^[A-Za-z0-9_-]*$/.test(invite)) {
      return reply.redirect("/login?error=invite_invalid");
    }
    const { token: state } = generateToken();
    reply.setCookie(OAUTH_COOKIE, [state, intent, invite].join("."), {
      httpOnly: true,
      sameSite: "lax",
      secure: ctx.secureCookies,
      path: OAUTH_COOKIE_PATH,
      maxAge: 600,
    });
    return reply.redirect(githubAuthorizeUrl(ctx.github, state, redirectUri));
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/api/auth/github/callback",
    async (request, reply) => {
      if (!ctx.github) {
        return reply.code(404).send({ error: "Not Found" });
      }
      const [state, intent, invite] = (request.cookies[OAUTH_COOKIE] ?? "").split(".");
      reply.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });
      if (!state || state !== request.query.state || !request.query.code) {
        return reply.redirect("/login?error=github_state");
      }

      let profile: GithubProfile;
      try {
        profile = await fetchGithubProfile(ctx.github, request.query.code, redirectUri, ctx.githubFetch);
      } catch (error) {
        request.log.warn({ err: error }, "GitHub sign-in failed");
        return reply.redirect(intent === "connect" ? "/settings?error=github_failed" : "/login?error=github_failed");
      }

      return intent === "connect" ? connect(request, reply, profile) : login(reply, profile, invite || undefined);
    }
  );

  async function connect(request: FastifyRequest, reply: FastifyReply, profile: GithubProfile) {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await findSessionUser(db, token) : undefined;
    if (!user) {
      return reply.redirect("/login?error=not_logged_in");
    }
    const linked = await findUserByGithubId(db, profile.id);
    if (linked && linked.id !== user.id) {
      return reply.redirect("/settings?error=github_taken");
    }
    await setGithubId(db, user.id, profile.id);
    return reply.redirect("/settings");
  }

  async function login(reply: FastifyReply, profile: GithubProfile, invite: string | undefined) {
    const linked = await findUserByGithubId(db, profile.id);
    if (linked) {
      await startSession(db, reply, linked.id, ctx.secureCookies);
      // An existing user who came from an invite link goes back to accept it.
      return reply.redirect(invite ? `/invite/${invite}` : "/");
    }
    if (!profile.email) {
      return reply.redirect("/login?error=github_no_email");
    }
    // Never auto-link by email: password accounts' emails are unverified, so the
    // account could belong to someone who registered this address in advance.
    if (await findUserByEmail(db, profile.email)) {
      return reply.redirect("/login?error=github_email_exists");
    }
    const result = await signUp(db, {
      email: profile.email,
      name: (profile.name?.trim() || profile.login).slice(0, 100),
      passwordHash: null,
      githubId: profile.id,
      inviteToken: invite,
      mode: ctx.signup,
    });
    if (!result.ok) {
      return reply.redirect(SIGNUP_REDIRECTS[result.reason]);
    }
    await startSession(db, reply, result.user.id, ctx.secureCookies);
    return reply.redirect("/");
  }
}
```

In `server/src/routes/me.ts`:
- Add these imports:

```ts
import { hashPassword, verifyPassword } from "../auth/password";
import { deleteUserSessions } from "../db/sessions";
import { setGithubId, setPasswordHash } from "../db/users";
```

- Add these routes inside `registerMeRoutes`, after `GET /api/me`:

```ts
  app.post<{ Body: { currentPassword?: string; newPassword: string } }>(
    "/api/me/password",
    {
      preValidation: requireUser(db),
      schema: {
        body: {
          type: "object",
          required: ["newPassword"],
          properties: {
            currentPassword: { type: "string", maxLength: 256 },
            newPassword: { type: "string", minLength: 8, maxLength: 256 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      // A GitHub-only user has no password yet and may set one without it.
      if (user.passwordHash !== null) {
        const { currentPassword } = request.body;
        if (currentPassword === undefined || !(await verifyPassword(currentPassword, user.passwordHash))) {
          return reply.code(403).send({ error: "Current password is incorrect" });
        }
      }
      await setPasswordHash(db, user.id, await hashPassword(request.body.newPassword));
      await deleteUserSessions(db, user.id, { except: request.sessionToken });
      return reply.code(204).send();
    }
  );

  app.delete("/api/me/github", { preValidation: requireUser(db) }, async (request, reply) => {
    const user = currentUser(request);
    if (user.passwordHash === null) {
      return reply.code(409).send({ error: "Set a password before disconnecting GitHub" });
    }
    await setGithubId(db, user.id, null);
    return reply.code(204).send();
  });
```

In `server/src/app.ts`, add `import { registerGithubRoutes } from "./routes/github";` and, after `registerProjectRoutes(app, ctx);`, add `registerGithubRoutes(app, ctx);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/auth src/routes`
Expected: PASS.

- [ ] **Step 5: Full suite, typecheck, lint, commit**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`

```bash
git add server/src
git commit -m "feat(server): add password change, GitHub OAuth login/connect and disconnect"
```

---

### Task 11: Serve the SPA; ship it in the Docker image

**Files:**
- Modify: `server/src/app.ts`, `server/Dockerfile`, `docker-compose.yml`
- Test: `server/src/static.test.ts`

**Interfaces:**
- Consumes: `AppOptions.dashboardDir` (Task 6), `@fastify/static` (installed in Task 6).
- Produces:
  - When `dashboardDir/index.html` exists, static files are served from it.
  - Any other GET outside `/api`, `/v1` and `/health` returns `index.html`.
  - Everything else keeps the JSON 404.

- [ ] **Step 1: Write the failing test**

Create `server/src/static.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestDb } from "../test/db";
import { buildTestApp, call } from "../test/http";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "repro-dashboard-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>repro-spa</title>");
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log('app')");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dashboard serving", () => {
  it("serves index.html at / and for client-side routes", async () => {
    const app = await buildTestApp(getTestDb(), { dashboardDir: dir });

    for (const url of ["/", "/orgs/123/projects", "/invite/rpi_abc?x=1", "/login"]) {
      const response = await call(app, "GET", url);
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
      expect(response.headers["content-type"]).toMatch(/^text\/html/);
      expect(response.body).toContain("repro-spa");
    }
  });

  it("serves built assets", async () => {
    const app = await buildTestApp(getTestDb(), { dashboardDir: dir });
    const response = await call(app, "GET", "/assets/app.js");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("console.log");
  });

  it("keeps JSON 404s for API paths and non-GET requests", async () => {
    const app = await buildTestApp(getTestDb(), { dashboardDir: dir });

    for (const url of ["/api/nope", "/v1/nope", "/api"]) {
      const response = await call(app, "GET", url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not Found" });
    }
    expect((await call(app, "POST", "/somewhere")).statusCode).toBe(404);
    expect((await call(app, "GET", "/health")).json()).toEqual({ status: "ok" });
  });

  it("serves nothing when the directory is unset or has no index.html", async () => {
    for (const dashboardDir of [undefined, path.join(dir, "missing")]) {
      const app = await buildTestApp(getTestDb(), { dashboardDir });
      const response = await call(app, "GET", "/");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not Found" });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- src/static.test.ts`
Expected: FAIL. `GET /` returns a JSON 404.

- [ ] **Step 3: Implement**

In `server/src/app.ts`:
- Add these imports:

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
```

- Add this helper above `buildApp`:

```ts
function isBackendPath(url: string): boolean {
  const pathname = url.split("?")[0];
  return /^\/(api|v1)(\/|$)/.test(pathname) || pathname === "/health";
}
```

- Replace the `app.setNotFoundHandler(...)` call with:

```ts
  const spaDir =
    options.dashboardDir && existsSync(path.join(options.dashboardDir, "index.html"))
      ? path.resolve(options.dashboardDir)
      : undefined;
  if (spaDir) {
    await app.register(fastifyStatic, { root: spaDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    // Client-side routes (/orgs/..., /invite/...) have no file on disk; serve
    // the SPA shell so a reload or a pasted link works.
    if (spaDir && request.method === "GET" && !isBackendPath(request.url)) {
      return reply.type("text/html").sendFile("index.html");
    }
    reply.code(404).send({ error: "Not Found" });
  });
```

Replace `server/Dockerfile` with:

```dockerfile
# The dashboard is built on Debian: Tailwind v4's native binary is resolved for
# the platform the lockfile was generated on (glibc), which alpine (musl) may lack.
FROM node:22-bookworm-slim AS dashboard-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/js/package.json packages/js/package.json
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
RUN npm ci
COPY dashboard dashboard
RUN npm run build -w dashboard

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/js/package.json packages/js/package.json
COPY server/package.json server/package.json
COPY dashboard/package.json dashboard/package.json
RUN npm ci
COPY packages/js packages/js
COPY server server
RUN npm run build -w packages/js
RUN npm run build -w server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/packages/js/dist packages/js/dist
COPY --from=build /app/packages/js/package.json packages/js/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/server/package.json server/package.json
COPY --from=dashboard-build /app/dashboard/dist dashboard/dist
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
```

(`dashboard/` doesn't exist until Task 12. The Docker build is exercised in Task 15.)

In `docker-compose.yml`, add this line to the `server` service's `environment`:

```yaml
      PUBLIC_URL: http://localhost:3000
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server`
Expected: PASS, including the existing `GET /nope` → JSON 404 test in `app.test.ts`, which runs without a `dashboardDir`.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck -w server && npm run lint -w server`

```bash
git add server/src/app.ts server/src/static.test.ts server/Dockerfile docker-compose.yml
git commit -m "feat(server): serve the dashboard SPA with a client-route fallback; build it into the image"
```

---
### Task 12: Dashboard workspace, API client, and auth pages

**Files:**
- Modify: `package.json` (root)
- Create:
  - `dashboard/package.json`, `dashboard/index.html`, `dashboard/tsconfig.json`, `dashboard/vite.config.ts`, `dashboard/eslint.config.js`
  - `dashboard/src/main.tsx`, `dashboard/src/index.css`, `dashboard/src/App.tsx`
  - `dashboard/src/api.ts`, `dashboard/src/types.ts`, `dashboard/src/queries.ts`, `dashboard/src/queryClient.ts`, `dashboard/src/auth.ts`, `dashboard/src/format.ts`
  - `dashboard/src/components/ui.tsx`, `dashboard/src/components/RequireAuth.tsx`
  - `dashboard/src/pages/LoginPage.tsx`, `dashboard/src/pages/SignupPage.tsx`, `dashboard/src/pages/HomePage.tsx`, `dashboard/src/pages/NewOrgPage.tsx`, `dashboard/src/pages/NotFoundPage.tsx`
  - `dashboard/src/test/setup.ts`, `dashboard/src/test/utils.tsx`, `dashboard/src/test/fixtures.ts`
- Test: `dashboard/src/pages/auth.test.tsx`

**Interfaces:**
- Consumes these server routes:
  - `GET /api/auth/config`
  - `POST /api/auth/login`, `POST /api/auth/signup`, which return the `MeBody` shape
  - `GET /api/me`
  - `POST /api/orgs`
- Produces:
  - `dashboard/src/api.ts`:
    - `class ApiError extends Error { status: number }`
    - `api<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>`
  - `dashboard/src/types.ts`: `Role`, `AuthConfig`, `UserOrg`, `Me`, `Project`, `CreatedProject`, `ApiKey`, `CreatedApiKey`, `Member`, `Invite`, `InvitePreview`.
  - `dashboard/src/queries.ts`:
    - `queryKeys`
    - `useAuthConfig()`, `useMe()`, `useProjects(orgId)`, `useKeys(orgId, projectId)`, `useMembers(orgId)`, `useInvites(orgId, enabled)`
    - `useOrgRole(orgId): Role | undefined`
  - `dashboard/src/queryClient.ts`: `createQueryClient()`.
  - `dashboard/src/auth.ts`:
    - `LOGIN_ERRORS`, `SETTINGS_ERRORS`
    - `safeNext(value)`, `inviteTokenFromNext(next)`, `githubHref(intent, invite?)`
  - `dashboard/src/format.ts`: `formatDate(iso: string): string`.
  - `dashboard/src/components/ui.tsx`: `Button`, `TextField`, `Card`, `Alert`, `ErrorText`, `PageHeader`, `FullPageMessage`, `AuthCard`.
  - `dashboard/src/App.tsx`: `AppRoutes`.
  - Test helpers:
    - `mockApi(handlers): ApiCall[]`
    - `renderApp(path): { client }`, which renders a `data-testid="location"` probe.
    - Fixtures `ME`, `ORG_ID`, `CONFIG_OPEN`, `CONFIG_CLOSED`.

- [ ] **Step 1: Scaffold the workspace**

In the root `package.json`, change `"workspaces"` to `["packages/*", "server", "dashboard"]`.

Create `dashboard/package.json`:

```json
{
  "name": "@repro/dashboard",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router": "^7.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/jest-dom": "^6.0.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/user-event": "^14.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "eslint": "^9.0.0",
    "globals": "^17.12.0",
    "jsdom": "^25.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

Create `dashboard/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>repro</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `dashboard/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

Create `dashboard/vite.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Run the server with PUBLIC_URL=http://localhost:5173 in dev, so the CSRF
    // Origin check and invite links match the Vite origin.
    proxy: { "/api": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

Create `dashboard/eslint.config.js`:

```js
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module", ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
```

Run from the repo root: `npm install`
Expected: installs the dashboard dependencies and updates `package-lock.json`. Check that React wasn't duplicated: `npm ls react` should show a single `react@18.x` (deduped) for `@repro/dashboard` and `@repro/js`.

- [ ] **Step 2: Add the styling base and entry point**

Create `dashboard/src/index.css`:

```css
@import "tailwindcss";

/* Design tokens. Declared once here; Tailwind exposes each as a utility
   (bg-surface, text-muted, border-border, ...) and as a CSS variable
   (var(--color-accent)), which the 4b charts read their colors from. */
@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --color-bg: #f6f6f7;
  --color-surface: #ffffff;
  --color-fg: #18181b;
  --color-muted: #6b6b76;
  --color-border: #e4e4e7;
  --color-accent: #4f46e5;
  --color-accent-fg: #ffffff;
  --color-danger: #dc2626;
}

@layer base {
  @media (prefers-color-scheme: dark) {
    :root {
      --color-bg: #0c0c0e;
      --color-surface: #16161a;
      --color-fg: #f4f4f5;
      --color-muted: #a1a1aa;
      --color-border: #2a2a31;
      --color-accent: #818cf8;
      --color-accent-fg: #0c0c0e;
      --color-danger: #f87171;
    }
  }

  body {
    @apply bg-bg font-sans text-fg antialiased;
  }
}
```

Create `dashboard/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes } from "./App";
import { createQueryClient } from "./queryClient";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
```

- [ ] **Step 3: Add the API client, types, queries and helpers**

Create `dashboard/src/api.ts`:

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

// Same-origin JSON calls to the server's /api routes. Content-Type is sent only
// with a body: the server rejects an empty body declared as JSON, and its CSRF
// guard accepts body-less requests without one.
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (response.status === 204) {
    return undefined as T;
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}
```

Create `dashboard/src/types.ts`:

```ts
// JSON shapes of the server's /api responses (dates arrive as ISO strings).

export type Role = "owner" | "member";

export interface AuthConfig {
  signup: "open" | "invite-only";
  bootstrapped: boolean;
  github: boolean;
}

export interface UserOrg {
  id: string;
  name: string;
  role: Role;
}

export interface Me {
  user: { id: string; email: string; name: string; hasPassword: boolean; githubConnected: boolean };
  orgs: UserOrg[];
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
  activeKeyCount: number;
}

export interface CreatedProject {
  project: Omit<Project, "activeKeyCount">;
  key: string;
}

export interface ApiKey {
  id: string;
  projectId: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  key: string;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

export interface Invite {
  id: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  createdByName: string;
}

export interface InvitePreview {
  orgName: string;
  role: Role;
}
```

Create `dashboard/src/queries.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { ApiKey, AuthConfig, Invite, Me, Member, Project, Role } from "./types";

export const queryKeys = {
  config: ["auth-config"] as const,
  me: ["me"] as const,
  projects: (orgId: string) => ["orgs", orgId, "projects"] as const,
  keys: (orgId: string, projectId: string) => ["orgs", orgId, "projects", projectId, "keys"] as const,
  members: (orgId: string) => ["orgs", orgId, "members"] as const,
  invites: (orgId: string) => ["orgs", orgId, "invites"] as const,
};

export function useAuthConfig() {
  return useQuery({ queryKey: queryKeys.config, queryFn: () => api<AuthConfig>("GET", "/api/auth/config") });
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => api<Me>("GET", "/api/me") });
}

export function useProjects(orgId: string) {
  return useQuery({
    queryKey: queryKeys.projects(orgId),
    queryFn: async () => (await api<{ projects: Project[] }>("GET", `/api/orgs/${orgId}/projects`)).projects,
  });
}

export function useKeys(orgId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.keys(orgId, projectId),
    queryFn: async () =>
      (await api<{ keys: ApiKey[] }>("GET", `/api/orgs/${orgId}/projects/${projectId}/keys`)).keys,
  });
}

export function useMembers(orgId: string) {
  return useQuery({
    queryKey: queryKeys.members(orgId),
    queryFn: async () => (await api<{ members: Member[] }>("GET", `/api/orgs/${orgId}/members`)).members,
  });
}

/** Pending invites; only owners may list them, so pass `enabled: isOwner`. */
export function useInvites(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.invites(orgId),
    queryFn: async () => (await api<{ invites: Invite[] }>("GET", `/api/orgs/${orgId}/invites`)).invites,
    enabled,
  });
}

/** The current user's role in the org, or undefined if they aren't a member. */
export function useOrgRole(orgId: string): Role | undefined {
  return useMe().data?.orgs.find((org) => org.id === orgId)?.role;
}
```

Create `dashboard/src/queryClient.ts`:

```ts
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";
import { queryKeys } from "./queries";

export function createQueryClient(): QueryClient {
  // A 401 from any request means the session is gone (expired, logged out
  // elsewhere, password changed). Refetching "me" makes RequireAuth send the
  // user to /login. Skipped for "me" itself, which would loop.
  const onUnauthorized = (error: Error, queryKey?: readonly unknown[]) => {
    if (error instanceof ApiError && error.status === 401 && queryKey?.[0] !== queryKeys.me[0]) {
      void client.invalidateQueries({ queryKey: queryKeys.me });
    }
  };

  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error, query) => onUnauthorized(error, query.queryKey) }),
    mutationCache: new MutationCache({ onError: (error) => onUnauthorized(error) }),
    defaultOptions: {
      // API errors are answers, not blips — don't retry them.
      queries: { retry: (failureCount, error) => !(error instanceof ApiError) && failureCount < 2 },
    },
  });
  return client;
}
```

Create `dashboard/src/auth.ts`:

```ts
// Messages for the `error` codes the server's GitHub callback redirects with.
export const LOGIN_ERRORS: Record<string, string> = {
  github_state: "GitHub sign-in expired. Please try again.",
  github_failed: "GitHub sign-in failed. Please try again.",
  github_no_email: "Your GitHub account has no verified email address.",
  github_email_exists:
    "An account with this email already exists. Log in with your password and connect GitHub from settings.",
  signup_closed: "Signup is invite-only on this instance. Ask an organization owner for an invite link.",
  invite_invalid: "This invite link is invalid or has expired.",
  not_logged_in: "Log in first, then connect GitHub from settings.",
};

export const SETTINGS_ERRORS: Record<string, string> = {
  github_taken: "That GitHub account is already linked to another user.",
  github_failed: "Connecting GitHub failed. Please try again.",
};

/** A post-login redirect target, only if it's a path on this site (no open redirects). */
export function safeNext(value: string | null): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

export function inviteTokenFromNext(next: string | null): string | undefined {
  return next?.match(/^\/invite\/([A-Za-z0-9_-]+)/)?.[1];
}

export function githubHref(intent: "login" | "connect", invite?: string): string {
  const params = new URLSearchParams({ intent });
  if (invite) {
    params.set("invite", invite);
  }
  return `/api/auth/github?${params}`;
}
```

Create `dashboard/src/format.ts`:

```ts
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
```

- [ ] **Step 4: Add the UI kit, guard and pages**

Create `dashboard/src/components/ui.tsx`:

```tsx
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-border bg-surface text-fg hover:bg-bg",
  danger: "border border-danger text-danger hover:bg-danger hover:text-white",
};

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

export function TextField({ label, value, onChange, className = "", ...props }: TextFieldProps) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 block font-medium">{label}</span>
      <input
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-fg outline-none focus:border-accent"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </label>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-lg border border-border bg-surface p-6 ${className}`}>{children}</section>;
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </div>
  );
}

export function ErrorText({ error }: { error: Error | null | undefined }) {
  return error ? (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  ) : null;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}

export function FullPageMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center text-sm text-muted">{children}</div>;
}

/** Centered card used by login, signup and invite pages. */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4">
      <p className="mb-6 text-lg font-semibold tracking-tight">repro</p>
      <Card className="w-full max-w-sm space-y-4">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </Card>
    </div>
  );
}
```

Create `dashboard/src/components/RequireAuth.tsx`:

```tsx
import { Navigate, Outlet, useLocation } from "react-router";
import { ApiError } from "../api";
import { useMe } from "../queries";
import { FullPageMessage } from "./ui";

// Gate for every logged-in page: children can assume useMe().data is loaded.
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.error instanceof ApiError && me.error.status === 401) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  // Checked before other errors: a failed background refetch keeps the page up.
  if (me.data) {
    return <Outlet />;
  }
  if (me.error) {
    return <FullPageMessage>{me.error.message}</FullPageMessage>;
  }
  return <FullPageMessage>Loading…</FullPageMessage>;
}
```

Create `dashboard/src/pages/LoginPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { LOGIN_ERRORS, githubHref, inviteTokenFromNext, safeNext } from "../auth";
import { Alert, AuthCard, Button, ErrorText, TextField } from "../components/ui";
import { queryKeys, useAuthConfig } from "../queries";
import type { Me } from "../types";

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const inviteToken = inviteTokenFromNext(next);
  const errorCode = params.get("error");
  const config = useAuthConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api<Me>("POST", "/api/auth/login", { email, password }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.me, me);
      navigate(next ?? "/", { replace: true });
    },
  });

  const canSignUp =
    config.data && (config.data.signup === "open" || !config.data.bootstrapped || inviteToken !== undefined);

  return (
    <AuthCard title="Log in">
      {errorCode && <Alert>{LOGIN_ERRORS[errorCode] ?? "Something went wrong. Please try again."}</Alert>}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} required />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          required
        />
        <ErrorText error={login.error} />
        <Button type="submit" className="w-full" disabled={login.isPending}>
          Log in
        </Button>
      </form>
      {config.data?.github && (
        <a
          href={githubHref("login", inviteToken)}
          className="flex w-full items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-bg"
        >
          Continue with GitHub
        </a>
      )}
      {canSignUp && (
        <p className="text-sm text-muted">
          No account?{" "}
          <Link className="text-accent hover:underline" to={inviteToken ? `/signup?invite=${inviteToken}` : "/signup"}>
            Sign up
          </Link>
        </p>
      )}
    </AuthCard>
  );
}
```

Create `dashboard/src/pages/SignupPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { githubHref } from "../auth";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";
import { queryKeys, useAuthConfig } from "../queries";
import type { Me } from "../types";

export function SignupPage() {
  const [params] = useSearchParams();
  const inviteToken = params.get("invite") ?? undefined;
  const config = useAuthConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signup = useMutation({
    mutationFn: () => api<Me>("POST", "/api/auth/signup", { name, email, password, inviteToken }),
    onSuccess: (me) => {
      queryClient.setQueryData(queryKeys.me, me);
      navigate("/", { replace: true });
    },
  });

  const closed =
    config.data && config.data.signup === "invite-only" && config.data.bootstrapped && inviteToken === undefined;
  const loginLink = inviteToken ? `/login?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : "/login";

  if (closed) {
    return (
      <AuthCard title="Signup is invite-only">
        <p className="text-sm text-muted">Ask an organization owner for an invite link.</p>
        <Link className="text-sm text-accent hover:underline" to="/login">
          Back to log in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title={inviteToken ? "Create an account to join" : "Create your account"}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          signup.mutate();
        }}
      >
        <TextField label="Name" autoComplete="name" value={name} onChange={setName} required maxLength={100} />
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} required />
        <TextField
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          maxLength={256}
        />
        <ErrorText error={signup.error} />
        <Button type="submit" className="w-full" disabled={signup.isPending}>
          Sign up
        </Button>
      </form>
      {config.data?.github && (
        <a
          href={githubHref("login", inviteToken)}
          className="flex w-full items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-bg"
        >
          Sign up with GitHub
        </a>
      )}
      <p className="text-sm text-muted">
        Already have an account?{" "}
        <Link className="text-accent hover:underline" to={loginLink}>
          Log in
        </Link>
      </p>
    </AuthCard>
  );
}
```

Create `dashboard/src/pages/HomePage.tsx`:

```tsx
import { Navigate } from "react-router";
import { useMe } from "../queries";

// "/" goes to the first org the user belongs to, or to creating one.
export function HomePage() {
  const first = useMe().data?.orgs[0];
  return <Navigate to={first ? `/orgs/${first.id}/projects` : "/orgs/new"} replace />;
}
```

Create `dashboard/src/pages/NewOrgPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, ErrorText, TextField } from "../components/ui";
import { queryKeys, useMe } from "../queries";
import type { Me, UserOrg } from "../types";

export function NewOrgPage() {
  const hasOrgs = (useMe().data?.orgs.length ?? 0) > 0;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: () => api<UserOrg>("POST", "/api/orgs", { name }),
    onSuccess: (org) => {
      queryClient.setQueryData<Me>(queryKeys.me, (me) => me && { ...me, orgs: [...me.orgs, org] });
      navigate(`/orgs/${org.id}/projects`);
    },
  });

  return (
    <Card className="mx-auto mt-16 max-w-md space-y-4">
      <h1 className="text-lg font-semibold">{hasOrgs ? "New organization" : "Create your organization"}</h1>
      {!hasOrgs && <p className="text-sm text-muted">You aren't a member of any organization yet.</p>}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <TextField label="Organization name" value={name} onChange={setName} required maxLength={100} />
        <ErrorText error={create.error} />
        <Button type="submit" disabled={create.isPending}>
          Create organization
        </Button>
      </form>
    </Card>
  );
}
```

Create `dashboard/src/pages/NotFoundPage.tsx`:

```tsx
import { Link } from "react-router";
import { FullPageMessage } from "../components/ui";

export function NotFoundPage() {
  return (
    <FullPageMessage>
      <span>
        Page not found.{" "}
        <Link className="text-accent hover:underline" to="/">
          Go home
        </Link>
      </span>
    </FullPageMessage>
  );
}
```

Create `dashboard/src/App.tsx`:

```tsx
import { Route, Routes } from "react-router";
import { RequireAuth } from "./components/RequireAuth";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NewOrgPage } from "./pages/NewOrgPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SignupPage } from "./pages/SignupPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<HomePage />} />
        <Route path="orgs/new" element={<NewOrgPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
```

- [ ] **Step 5: Add the test harness**

Create `dashboard/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
```

Create `dashboard/src/test/utils.tsx`:

```tsx
import { render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { vi } from "vitest";
import { AppRoutes } from "../App";
import { createQueryClient } from "../queryClient";

export interface MockResponse {
  status?: number;
  body?: unknown;
}

/** A canned response, or a function of the parsed request body. */
export type MockHandler = MockResponse | ((body: unknown) => MockResponse);

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Replaces fetch with handlers keyed by "METHOD /path". Unhandled requests get a
 * 404. Handlers are looked up per request, so a test can reassign one mid-test.
 * Returns the list of calls made.
 */
export function mockApi(handlers: Record<string, MockHandler>): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const handler = handlers[`${method} ${path}`];
      const result: MockResponse =
        handler === undefined
          ? { status: 404, body: { error: "Not Found" } }
          : typeof handler === "function"
            ? handler(body)
            : handler;
      const status = result.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(result.body ?? {}), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return calls;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

/** Renders the whole app at `path`, plus a data-testid="location" probe. */
export function renderApp(path: string) {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { client };
}
```

Create `dashboard/src/test/fixtures.ts`:

```ts
import type { AuthConfig, Me } from "../types";

export const ORG_ID = "org-1";

export const ME: Me = {
  user: { id: "user-1", email: "ana@example.com", name: "Ana", hasPassword: true, githubConnected: false },
  orgs: [{ id: ORG_ID, name: "Acme", role: "owner" }],
};

export const CONFIG_OPEN: AuthConfig = { signup: "open", bootstrapped: true, github: true };
export const CONFIG_CLOSED: AuthConfig = { signup: "invite-only", bootstrapped: true, github: false };
```

- [ ] **Step 6: Write the failing tests**

Create `dashboard/src/pages/auth.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_CLOSED, CONFIG_OPEN, ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const location = () => screen.getByTestId("location");

describe("login", () => {
  it("logs in and lands on the first org's projects", async () => {
    const calls = mockApi({
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/auth/login": { body: ME },
    });
    const user = userEvent.setup();
    renderApp("/login");

    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      email: "ana@example.com",
      password: "long-password",
    });
  });

  it("shows the server's error for bad credentials", async () => {
    mockApi({
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/auth/login": { status: 401, body: { error: "Invalid email or password" } },
    });
    const user = userEvent.setup();
    renderApp("/login");

    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
    expect(location()).toHaveTextContent("/login");
  });

  it("offers signup and GitHub only when the instance allows them", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/login");
    expect(await screen.findByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/github?intent=login"
    );
  });

  it("hides signup and GitHub on a bootstrapped invite-only instance", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_CLOSED } });
    renderApp("/login");
    await screen.findByRole("button", { name: "Log in" });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Sign up" })).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Continue with GitHub" })).not.toBeInTheDocument();
  });

  it("carries an invite through to signup and after login", async () => {
    mockApi({
      "GET /api/auth/config": { body: CONFIG_CLOSED },
      "POST /api/auth/login": { body: ME },
    });
    const user = userEvent.setup();
    renderApp("/login?next=%2Finvite%2Frpi_abc");

    expect(await screen.findByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup?invite=rpi_abc");

    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(location()).toHaveTextContent("/invite/rpi_abc"));
  });

  it("ignores an off-site next parameter", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_OPEN }, "POST /api/auth/login": { body: ME } });
    const user = userEvent.setup();
    renderApp("/login?next=%2F%2Fevil.example");

    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
  });

  it("explains a GitHub error code", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/login?error=github_email_exists");
    expect(await screen.findByRole("alert")).toHaveTextContent("An account with this email already exists");
  });
});

describe("signup", () => {
  it("signs up with the invite token from the URL", async () => {
    const calls = mockApi({
      "GET /api/auth/config": { body: CONFIG_CLOSED },
      "POST /api/auth/signup": { status: 201, body: ME },
    });
    const user = userEvent.setup();
    renderApp("/signup?invite=rpi_abc");

    await user.type(await screen.findByLabelText("Name"), "Ana");
    await user.type(screen.getByLabelText("Email"), "ana@example.com");
    await user.type(screen.getByLabelText("Password"), "long-password");
    await user.click(screen.getByRole("button", { name: "Sign up" }));

    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Ana",
      email: "ana@example.com",
      password: "long-password",
      inviteToken: "rpi_abc",
    });
  });

  it("says signup is closed on a bootstrapped invite-only instance", async () => {
    mockApi({ "GET /api/auth/config": { body: CONFIG_CLOSED } });
    renderApp("/signup");
    expect(await screen.findByRole("heading", { name: "Signup is invite-only" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign up" })).not.toBeInTheDocument();
  });
});

describe("logged-in routes", () => {
  it("send a logged-out visitor to login, remembering where they were going", async () => {
    mockApi({
      "GET /api/me": { status: 401, body: { error: "Not logged in" } },
      "GET /api/auth/config": { body: CONFIG_OPEN },
    });
    renderApp("/orgs/new");
    await waitFor(() => expect(location()).toHaveTextContent("/login?next=%2Forgs%2Fnew"));
  });

  it("send a user without orgs to create one", async () => {
    mockApi({
      "GET /api/me": { body: { ...ME, orgs: [] } },
      "POST /api/orgs": { status: 201, body: { id: "org-9", name: "Beta", role: "owner" } },
    });
    const user = userEvent.setup();
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Create your organization" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Organization name"), "Beta");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(location()).toHaveTextContent("/orgs/org-9/projects"));
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w dashboard`
Expected: PASS. The tests were written against the code above. A failure is a real bug in either the page or the test, so fix it before moving on. Common causes:
- A label mismatch. Check that `getByLabelText` matches the `TextField` label exactly.
- A missing `mockApi` handler. An unhandled request gets a 404, which appears as an error text.

- [ ] **Step 8: Build, typecheck, lint**

Run: `npm run build -w dashboard && npm run lint -w dashboard`
Expected: `dashboard/dist/index.html` plus hashed assets; both commands exit 0. Check that the build output includes Tailwind classes: `grep -l "bg-surface" dashboard/dist/assets/*.css` should print a file.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json dashboard
git commit -m "feat(dashboard): scaffold the dashboard SPA with login, signup and org creation"
```

---
### Task 13: Dashboard app shell, projects and keys

**Files:**
- Create: `dashboard/src/components/AppShell.tsx`, `dashboard/src/components/OnceSecret.tsx`, `dashboard/src/pages/OrgLayout.tsx`, `dashboard/src/pages/ProjectsPage.tsx`, `dashboard/src/pages/ProjectPage.tsx`
- Modify: `dashboard/src/components/ui.tsx`, `dashboard/src/App.tsx`
- Test: `dashboard/src/pages/projects.test.tsx`

**Interfaces:**
- Consumes:
  - `api`, `ApiError`, `queryKeys`, `useMe`, `useProjects`, `useKeys`, the UI kit, and the test helpers (Task 12)
  - these server routes: projects/keys (Task 9) and logout (Task 6)
- Produces:
  - `ConfirmButton({ label, confirmLabel, onConfirm, disabled? })`, added to `ui.tsx`.
  - `OnceSecret({ label, value, onDismiss })`.
  - `AppShell`, containing the header with the org switcher (`aria-label="Organization"`), a link to `/settings` showing the user's name, and "Log out".
  - `OrgLayout`, with a `TABS` array that Task 14 extends.
  - Routes `/orgs/:orgId/projects` and `/orgs/:orgId/projects/:projectId`.

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/pages/projects.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";
import type { ApiKey, Project } from "../types";

const PROJECT: Project = { id: "proj-1", orgId: ORG_ID, name: "web", createdAt: "2026-09-01T00:00:00.000Z", activeKeyCount: 1 };
const KEY: ApiKey = { id: "key-1", projectId: "proj-1", prefix: "rpk_AbCdEfGh", createdAt: "2026-09-01T00:00:00.000Z", revokedAt: null };

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    "GET /api/me": { body: ME },
    [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } },
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/keys`]: { body: { keys: [KEY] } },
    ...extra,
  };
}

const location = () => screen.getByTestId("location");

describe("projects page", () => {
  it("lists the org's projects", async () => {
    mockApi(handlers());
    renderApp(`/orgs/${ORG_ID}/projects`);
    expect(await screen.findByRole("link", { name: "web" })).toHaveAttribute("href", `/orgs/${ORG_ID}/projects/proj-1`);
  });

  it("creates a project and shows its key until dismissed", async () => {
    const calls = mockApi(
      handlers({
        [`POST /api/orgs/${ORG_ID}/projects`]: {
          status: 201,
          body: { project: { id: "proj-2", orgId: ORG_ID, name: "api", createdAt: PROJECT.createdAt }, key: "rpk_created" },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects`);

    await user.type(await screen.findByLabelText("New project name"), "api");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText("rpk_created")).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "api" });

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("rpk_created")).not.toBeInTheDocument();
  });

  it("says so when the user isn't a member of the org", async () => {
    mockApi(handlers());
    renderApp("/orgs/someone-elses/projects");
    expect(await screen.findByRole("heading", { name: "Organization not found" })).toBeInTheDocument();
  });
});

describe("project page", () => {
  it("shows the ingest endpoint and the key prefixes", async () => {
    mockApi(handlers());
    renderApp(`/orgs/${ORG_ID}/projects/proj-1`);

    expect(await screen.findByRole("heading", { name: "web" })).toBeInTheDocument();
    expect(screen.getByText(/\/v1\/timeline$/)).toBeInTheDocument();
    expect(await screen.findByText("rpk_AbCdEfGh…")).toBeInTheDocument();
  });

  it("shows a new key once; it's gone after navigating away and back", async () => {
    mockApi(
      handlers({
        [`POST /api/orgs/${ORG_ID}/projects/proj-1/keys`]: {
          status: 201,
          body: { apiKey: { ...KEY, id: "key-2", prefix: "rpk_Second12" }, key: "rpk_second_full_key" },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/proj-1`);

    await user.click(await screen.findByRole("button", { name: "Create key" }));
    expect(await screen.findByText("rpk_second_full_key")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Projects" }));
    await user.click(await screen.findByRole("link", { name: "web" }));
    await screen.findByRole("heading", { name: "web" });
    expect(screen.queryByText("rpk_second_full_key")).not.toBeInTheDocument();
  });

  it("revokes a key only after confirmation", async () => {
    const calls = mockApi(
      handlers({
        [`POST /api/orgs/${ORG_ID}/projects/proj-1/keys/key-1/revoke`]: {
          body: { apiKey: { ...KEY, revokedAt: "2026-09-02T00:00:00.000Z" }, alreadyRevoked: false },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/proj-1`);

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/key-1/revoke"))).toBe(true));
  });
});

describe("app shell", () => {
  it("switches orgs and offers creating a new one", async () => {
    mockApi(
      handlers({
        "GET /api/me": { body: { ...ME, orgs: [...ME.orgs, { id: "org-2", name: "Beta", role: "member" }] } },
        "GET /api/orgs/org-2/projects": { body: { projects: [] } },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects`);

    await user.selectOptions(await screen.findByLabelText("Organization"), "Beta");
    await waitFor(() => expect(location()).toHaveTextContent("/orgs/org-2/projects"));

    await user.selectOptions(screen.getByLabelText("Organization"), "+ New organization…");
    await waitFor(() => expect(location()).toHaveTextContent("/orgs/new"));
  });

  it("logs out", async () => {
    const calls = mockApi(handlers({ "POST /api/auth/logout": { status: 204 }, "GET /api/auth/config": { body: { signup: "open", bootstrapped: true, github: false } } }));
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects`);

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    await waitFor(() => expect(location()).toHaveTextContent(/^\/login/));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/auth/logout")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w dashboard -- src/pages/projects.test.tsx`
Expected: FAIL. The routes don't exist, so `NotFoundPage` renders.

- [ ] **Step 3: Implement**

In `dashboard/src/components/ui.tsx`, add `import { useState } from "react";` at the top and append:

```tsx
/** Two-step button for destructive actions: the first click asks, the second acts. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled = false,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="secondary" disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="inline-flex gap-2">
      <Button
        variant="danger"
        disabled={disabled}
        onClick={() => {
          setConfirming(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="secondary" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}
```

Create `dashboard/src/components/OnceSecret.tsx`:

```tsx
import { useState } from "react";
import { Button } from "./ui";

// A newly created API key or invite link. It lives only in the creating page's
// state, so it disappears on dismiss or navigation. The server can't show it again.
export function OnceSecret({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div role="status" className="rounded-lg border border-accent/40 bg-accent/5 p-4">
      <p className="text-sm font-medium">{label}</p>
      <p className="mb-3 text-sm text-muted">Copy it now. It won't be shown again.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-bg px-2 py-1.5 font-mono text-sm">{value}</code>
        <Button
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}
```

Create `dashboard/src/components/AppShell.tsx`:

```tsx
import { Link, Outlet, useMatch, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useMe } from "../queries";
import type { UserOrg } from "../types";
import { Button } from "./ui";

const NEW_ORG = "__new__";

function OrgSwitcher({ orgs, currentOrgId }: { orgs: UserOrg[]; currentOrgId: string | undefined }) {
  const navigate = useNavigate();
  return (
    <select
      aria-label="Organization"
      className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
      value={currentOrgId ?? ""}
      onChange={(event) =>
        navigate(event.target.value === NEW_ORG ? "/orgs/new" : `/orgs/${event.target.value}/projects`)
      }
    >
      {currentOrgId === undefined && (
        <option value="" disabled>
          Select organization
        </option>
      )}
      {orgs.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
      <option value={NEW_ORG}>+ New organization…</option>
    </select>
  );
}

export function AppShell() {
  const me = useMe().data!; // RequireAuth renders this only once "me" has loaded
  const matchedOrgId = useMatch("/orgs/:orgId/*")?.params.orgId;
  const currentOrgId = me.orgs.some((org) => org.id === matchedOrgId) ? matchedOrgId : undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => api<void>("POST", "/api/auth/logout"),
    onSuccess: () => {
      navigate("/login", { replace: true });
      queryClient.clear();
    },
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-3">
          <Link to="/" className="font-semibold tracking-tight">
            repro
          </Link>
          <OrgSwitcher orgs={me.orgs} currentOrgId={currentOrgId} />
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link to="/settings" className="text-muted hover:text-fg">
              {me.user.name}
            </Link>
            <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
```

Create `dashboard/src/pages/OrgLayout.tsx`:

```tsx
import { Link, NavLink, Outlet, useParams } from "react-router";
import { Card } from "../components/ui";
import { useMe } from "../queries";

// `ownerOnly` tabs are hidden from members (the server enforces it regardless).
const TABS: { path: string; label: string; ownerOnly?: boolean }[] = [{ path: "projects", label: "Projects" }];

export function OrgLayout() {
  const { orgId = "" } = useParams();
  const org = useMe().data?.orgs.find((o) => o.id === orgId);

  if (!org) {
    return (
      <Card className="mx-auto max-w-md space-y-2">
        <h1 className="text-lg font-semibold">Organization not found</h1>
        <p className="text-sm text-muted">It doesn't exist, or you aren't a member.</p>
        <Link to="/" className="text-sm text-accent hover:underline">
          Go home
        </Link>
      </Card>
    );
  }

  const visible = TABS.filter((tab) => !tab.ownerOnly || org.role === "owner");
  return (
    <div className="space-y-6">
      <nav className="flex gap-6 border-b border-border">
        {visible.map((tab) => (
          <NavLink
            key={tab.path}
            to={`/orgs/${orgId}/${tab.path}`}
            className={({ isActive }) =>
              `-mb-px border-b-2 pb-2 text-sm ${isActive ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg"}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
```

Create `dashboard/src/pages/ProjectsPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ErrorText, PageHeader, TextField } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useProjects } from "../queries";
import type { CreatedProject } from "../types";

export function ProjectsPage() {
  const { orgId = "" } = useParams();
  const projects = useProjects(orgId);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedProject | null>(null);

  const create = useMutation({
    mutationFn: () => api<CreatedProject>("POST", `/api/orgs/${orgId}/projects`, { name }),
    onSuccess: (result) => {
      setCreated(result);
      setName("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects(orgId) });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Projects" />
      {created && (
        <OnceSecret
          label={`API key for ${created.project.name}`}
          value={created.key}
          onDismiss={() => setCreated(null)}
        />
      )}
      <Card>
        <form
          className="flex items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <TextField className="flex-1" label="New project name" value={name} onChange={setName} required maxLength={100} />
          <Button type="submit" disabled={create.isPending}>
            Create project
          </Button>
        </form>
        <ErrorText error={create.error} />
      </Card>
      {projects.error ? (
        <ErrorText error={projects.error} />
      ) : !projects.data ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : projects.data.length === 0 ? (
        <p className="text-sm text-muted">No projects yet. Create one to get an API key.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 font-medium">Name</th>
              <th className="font-medium">Active keys</th>
              <th className="font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {projects.data.map((project) => (
              <tr key={project.id} className="border-t border-border">
                <td className="py-2">
                  <Link className="font-medium text-accent hover:underline" to={`/orgs/${orgId}/projects/${project.id}`}>
                    {project.name}
                  </Link>
                </td>
                <td>{project.activeKeyCount}</td>
                <td>{formatDate(project.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

Create `dashboard/src/pages/ProjectPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ConfirmButton, ErrorText, PageHeader } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useKeys, useProjects } from "../queries";
import type { CreatedApiKey } from "../types";

export function ProjectPage() {
  const { orgId = "", projectId = "" } = useParams();
  const project = useProjects(orgId).data?.find((p) => p.id === projectId);
  const keys = useKeys(orgId, projectId);
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.keys(orgId, projectId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects(orgId) }),
    ]);

  const createKey = useMutation({
    mutationFn: () => api<CreatedApiKey>("POST", `/api/orgs/${orgId}/projects/${projectId}/keys`),
    onSuccess: (result) => {
      setNewKey(result.key);
      void refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: (keyId: string) => api("POST", `/api/orgs/${orgId}/projects/${projectId}/keys/${keyId}/revoke`),
    onSuccess: () => void refresh(),
  });

  if (keys.error instanceof ApiError && keys.error.status === 404) {
    return (
      <Card className="space-y-2">
        <h1 className="text-lg font-semibold">Project not found</h1>
        <Link to={`/orgs/${orgId}/projects`} className="text-sm text-accent hover:underline">
          All projects
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to={`/orgs/${orgId}/projects`} className="text-sm text-muted hover:text-fg">
          ← All projects
        </Link>
        <PageHeader title={project?.name ?? "Project"} />
      </div>

      <Card className="space-y-2">
        <h2 className="font-medium">Ingest endpoint</h2>
        <p className="text-sm text-muted">
          Point <code className="font-mono">@repro/js</code> at this URL and pass one of the keys below as{" "}
          <code className="font-mono">apiKey</code>.
        </p>
        <code className="block rounded-md bg-bg px-2 py-1.5 font-mono text-sm">{`${window.location.origin}/v1/timeline`}</code>
      </Card>

      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">API keys</h2>
          <Button onClick={() => createKey.mutate()} disabled={createKey.isPending}>
            Create key
          </Button>
        </div>
        {newKey && <OnceSecret label="New API key" value={newKey} onDismiss={() => setNewKey(null)} />}
        <ErrorText error={createKey.error ?? revoke.error ?? keys.error} />
        {keys.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-2 font-medium">Key</th>
                <th className="font-medium">Created</th>
                <th className="font-medium">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((key) => (
                <tr key={key.id} className="border-t border-border">
                  <td className="py-2 font-mono">{`${key.prefix}…`}</td>
                  <td>{formatDate(key.createdAt)}</td>
                  <td>{key.revokedAt ? `Revoked ${formatDate(key.revokedAt)}` : "Active"}</td>
                  <td className="text-right">
                    {!key.revokedAt && (
                      <ConfirmButton
                        label="Revoke"
                        confirmLabel="Confirm revoke"
                        disabled={revoke.isPending}
                        onConfirm={() => revoke.mutate(key.id)}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="space-y-1">
        <h2 className="font-medium">Timelines</h2>
        <p className="text-sm text-muted">Captured timelines will appear here.</p>
      </Card>
    </div>
  );
}
```

Replace `dashboard/src/App.tsx` with:

```tsx
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/AppShell";
import { RequireAuth } from "./components/RequireAuth";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NewOrgPage } from "./pages/NewOrgPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OrgLayout } from "./pages/OrgLayout";
import { ProjectPage } from "./pages/ProjectPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SignupPage } from "./pages/SignupPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="orgs/new" element={<NewOrgPage />} />
          <Route path="orgs/:orgId" element={<OrgLayout />}>
            <Route index element={<Navigate to="projects" replace />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<ProjectPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
```

- [ ] **Step 4: Run all dashboard tests**

Run: `npm test -w dashboard`
Expected: PASS, both `auth.test.tsx` and `projects.test.tsx`.

- [ ] **Step 5: Build, lint, commit**

Run: `npm run build -w dashboard && npm run lint -w dashboard`

```bash
git add dashboard/src
git commit -m "feat(dashboard): add app shell, org switcher, projects and API key management"
```

---

### Task 14: Dashboard members, invites and settings

**Files:**
- Create: `dashboard/src/pages/MembersPage.tsx`, `dashboard/src/pages/OrgSettingsPage.tsx`, `dashboard/src/pages/UserSettingsPage.tsx`, `dashboard/src/pages/InvitePage.tsx`
- Modify: `dashboard/src/pages/OrgLayout.tsx`, `dashboard/src/App.tsx`
- Test: `dashboard/src/pages/members.test.tsx`, `dashboard/src/pages/invite.test.tsx`, `dashboard/src/pages/settings.test.tsx`

**Interfaces:**
- Consumes:
  - `useMembers`, `useInvites`, `useOrgRole`, `useAuthConfig`, `SETTINGS_ERRORS`, `githubHref`, `OnceSecret`, `ConfirmButton` (Tasks 12–13)
  - these server routes: org/member/invite (Task 8) and settings (Task 10)
- Produces routes:
  - `/orgs/:orgId/members`, `/orgs/:orgId/settings` (tabs "Members", and "Settings" for owners only)
  - `/settings`
  - `/invite/:token` (public)

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/pages/members.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";
import type { Invite, Member } from "../types";

const MEMBERS: Member[] = [
  { userId: "user-1", name: "Ana", email: "ana@example.com", role: "owner", joinedAt: "2026-09-01T00:00:00.000Z" },
  { userId: "user-2", name: "Mark", email: "mark@example.com", role: "member", joinedAt: "2026-09-02T00:00:00.000Z" },
];
const INVITE: Invite = {
  id: "inv-1",
  role: "member",
  createdAt: "2026-09-03T00:00:00.000Z",
  expiresAt: "2026-09-10T00:00:00.000Z",
  createdByName: "Ana",
};
const AS_MEMBER = { ...ME, orgs: [{ id: ORG_ID, name: "Acme", role: "member" as const }] };

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    "GET /api/me": { body: ME },
    [`GET /api/orgs/${ORG_ID}/members`]: { body: { members: MEMBERS } },
    [`GET /api/orgs/${ORG_ID}/invites`]: { body: { invites: [INVITE] } },
    ...extra,
  };
}

describe("members page", () => {
  it("lets an owner change roles, remove members and manage invites", async () => {
    const calls = mockApi(
      handlers({
        [`PATCH /api/orgs/${ORG_ID}/members/user-2`]: { body: { userId: "user-2", role: "owner" } },
        [`POST /api/orgs/${ORG_ID}/invites`]: {
          status: 201,
          body: { invite: { ...INVITE, id: "inv-2" }, link: "http://localhost:3000/invite/rpi_link" },
        },
        [`DELETE /api/orgs/${ORG_ID}/invites/inv-1`]: { status: 204 },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/members`);

    await user.selectOptions(await screen.findByLabelText("Role for Mark"), "owner");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "owner" })
    );

    await user.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByText("http://localhost:3000/invite/rpi_link")).toBeInTheDocument();

    expect(screen.getByText(/Created by Ana/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/invites/inv-1"))).toBe(true));
  });

  it("shows a member no owner controls and no invites", async () => {
    const calls = mockApi(handlers({ "GET /api/me": { body: AS_MEMBER } }));
    renderApp(`/orgs/${ORG_ID}/members`);

    expect(await screen.findByText("mark@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Mark")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create invite link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Settings" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/invites"))).toBe(false);
  });

  it("lets a member leave, then sends them home", async () => {
    mockApi(
      handlers({
        "GET /api/me": { body: { ...AS_MEMBER, user: { ...AS_MEMBER.user, id: "user-2" } } },
        [`DELETE /api/orgs/${ORG_ID}/members/user-2`]: { status: 204 },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/members`);

    await user.click(await screen.findByRole("button", { name: "Leave" }));
    await user.click(screen.getByRole("button", { name: "Confirm leave" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orgs/new"));
  });

  it("shows the server's error, e.g. the last-owner rule", async () => {
    mockApi(
      handlers({
        [`PATCH /api/orgs/${ORG_ID}/members/user-1`]: {
          status: 409,
          body: { error: "An org must have at least one owner" },
        },
      })
    );
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/members`);

    await user.selectOptions(await screen.findByLabelText("Role for Ana"), "member");

    expect(await screen.findByText("An org must have at least one owner")).toBeInTheDocument();
  });
});
```

Create `dashboard/src/pages/invite.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const PREVIEW = { "GET /api/invites/rpi_tok": { body: { orgName: "Beta", role: "member" } } };

describe("invite page", () => {
  it("lets a logged-in user accept and lands them in the org", async () => {
    const calls = mockApi({
      ...PREVIEW,
      "GET /api/me": { body: ME },
      "POST /api/invites/rpi_tok/accept": { body: { orgId: "org-2" } },
      "GET /api/orgs/org-2/projects": { body: { projects: [] } },
    });
    const user = userEvent.setup();
    renderApp("/invite/rpi_tok");

    expect(await screen.findByRole("heading", { name: "Join Beta" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Accept invite" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orgs/org-2/projects"));
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("offers log in or sign up to a logged-out visitor, carrying the invite", async () => {
    mockApi({ ...PREVIEW, "GET /api/me": { status: 401, body: { error: "Not logged in" } } });
    renderApp("/invite/rpi_tok");

    expect(await screen.findByRole("link", { name: "Log in to accept" })).toHaveAttribute(
      "href",
      "/login?next=%2Finvite%2Frpi_tok"
    );
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", "/signup?invite=rpi_tok");
  });

  it("explains an unusable invite", async () => {
    mockApi({
      "GET /api/invites/rpi_tok": { status: 404, body: { error: "Invite not found or expired" } },
      "GET /api/me": { body: ME },
    });
    renderApp("/invite/rpi_tok");
    expect(await screen.findByText("Invite not found or expired")).toBeInTheDocument();
  });

  it("shows 'already a member' from the server", async () => {
    mockApi({
      ...PREVIEW,
      "GET /api/me": { body: ME },
      "POST /api/invites/rpi_tok/accept": { status: 409, body: { error: "Already a member" } },
    });
    const user = userEvent.setup();
    renderApp("/invite/rpi_tok");

    await user.click(await screen.findByRole("button", { name: "Accept invite" }));
    expect(await screen.findByText("Already a member")).toBeInTheDocument();
  });
});
```

Create `dashboard/src/pages/settings.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_OPEN, ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

describe("user settings", () => {
  it("changes the password with the current one", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/me/password": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText("Current password"), "old-password");
    await user.type(screen.getByLabelText("New password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/me/password")?.body).toEqual({
      currentPassword: "old-password",
      newPassword: "new-password",
    });
  });

  it("lets a GitHub-only user set a first password without a current one", async () => {
    mockApi({
      "GET /api/me": { body: { ...ME, user: { ...ME.user, hasPassword: false, githubConnected: true } } },
      "GET /api/auth/config": { body: CONFIG_OPEN },
    });
    renderApp("/settings");

    expect(await screen.findByRole("button", { name: "Set password" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect GitHub" })).toBeDisabled();
  });

  it("offers to connect GitHub when it's enabled", async () => {
    mockApi({ "GET /api/me": { body: ME }, "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/settings");
    expect(await screen.findByRole("link", { name: "Connect GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/github?intent=connect"
    );
  });

  it("explains a GitHub connect error", async () => {
    mockApi({ "GET /api/me": { body: ME }, "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/settings?error=github_taken");
    expect(await screen.findByRole("alert")).toHaveTextContent("already linked to another user");
  });
});

describe("org settings", () => {
  it("lets an owner rename the org", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      [`PATCH /api/orgs/${ORG_ID}`]: { body: { id: ORG_ID, name: "Acme Inc" } },
    });
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/settings`);

    const field = await screen.findByLabelText("Organization name");
    await user.clear(field);
    await user.type(field, "Acme Inc");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByLabelText("Organization")).toHaveDisplayValue("Acme Inc"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Acme Inc" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w dashboard`
Expected: FAIL. The new tests render `NotFoundPage`, while Tasks 12–13's tests still pass.

- [ ] **Step 3: Implement**

Create `dashboard/src/pages/MembersPage.tsx`:

```tsx
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ConfirmButton, ErrorText, PageHeader } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useInvites, useMe, useMembers, useOrgRole } from "../queries";
import type { Invite, Me, Role } from "../types";

export function MembersPage() {
  const { orgId = "" } = useParams();
  const me = useMe().data!;
  const isOwner = useOrgRole(orgId) === "owner";
  const members = useMembers(orgId);
  const invites = useInvites(orgId, isOwner);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);

  const invalidate = (queryKey: readonly unknown[]) => queryClient.invalidateQueries({ queryKey });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api("PATCH", `/api/orgs/${orgId}/members/${userId}`, { role }),
    onSettled: () => {
      void invalidate(queryKeys.members(orgId));
      void invalidate(queryKeys.me);
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) => api("DELETE", `/api/orgs/${orgId}/members/${userId}`),
    onSuccess: (_result, userId) => {
      if (userId === me.user.id) {
        queryClient.setQueryData<Me>(queryKeys.me, (old) => old && { ...old, orgs: old.orgs.filter((o) => o.id !== orgId) });
        navigate("/");
      } else {
        void invalidate(queryKeys.members(orgId));
      }
    },
  });

  const createInvite = useMutation({
    mutationFn: () => api<{ invite: Invite; link: string }>("POST", `/api/orgs/${orgId}/invites`, { role: inviteRole }),
    onSuccess: (result) => {
      setLink(result.link);
      void invalidate(queryKeys.invites(orgId));
    },
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) => api("DELETE", `/api/orgs/${orgId}/invites/${inviteId}`),
    onSuccess: () => void invalidate(queryKeys.invites(orgId)),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Members" />
      <ErrorText error={changeRole.error ?? remove.error ?? createInvite.error ?? revokeInvite.error ?? members.error} />
      {members.data && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 font-medium">Name</th>
              <th className="font-medium">Email</th>
              <th className="font-medium">Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.data.map((member) => {
              const isSelf = member.userId === me.user.id;
              return (
                <tr key={member.userId} className="border-t border-border">
                  <td className="py-2">{member.name}</td>
                  <td>{member.email}</td>
                  <td>
                    {isOwner ? (
                      <select
                        aria-label={`Role for ${member.name}`}
                        className="rounded-md border border-border bg-surface px-2 py-1"
                        value={member.role}
                        onChange={(event) =>
                          changeRole.mutate({ userId: member.userId, role: event.target.value as Role })
                        }
                      >
                        <option value="owner">owner</option>
                        <option value="member">member</option>
                      </select>
                    ) : (
                      member.role
                    )}
                  </td>
                  <td className="text-right">
                    {isSelf ? (
                      <ConfirmButton label="Leave" confirmLabel="Confirm leave" onConfirm={() => remove.mutate(member.userId)} />
                    ) : (
                      isOwner && (
                        <ConfirmButton label="Remove" confirmLabel="Confirm remove" onConfirm={() => remove.mutate(member.userId)} />
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {isOwner && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">Invites</h2>
            <div className="flex items-center gap-2">
              <select
                aria-label="Invite role"
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as Role)}
              >
                <option value="member">member</option>
                <option value="owner">owner</option>
              </select>
              <Button onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
                Create invite link
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted">Links work once and expire after 7 days. Send one to the person you're inviting.</p>
          {link && <OnceSecret label="Invite link" value={link} onDismiss={() => setLink(null)} />}
          {invites.data && invites.data.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {invites.data.map((invite) => (
                <li key={invite.id} className="flex items-center justify-between py-2">
                  <span>
                    {invite.role} · Created by {invite.createdByName} · Expires {formatDate(invite.expiresAt)}
                  </span>
                  <ConfirmButton label="Revoke" confirmLabel="Confirm revoke" onConfirm={() => revokeInvite.mutate(invite.id)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
```

Create `dashboard/src/pages/OrgSettingsPage.tsx`:

```tsx
import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Button, Card, ErrorText, PageHeader, TextField } from "../components/ui";
import { queryKeys, useMe } from "../queries";
import type { Me } from "../types";

export function OrgSettingsPage() {
  const { orgId = "" } = useParams();
  const org = useMe().data!.orgs.find((o) => o.id === orgId)!; // OrgLayout checked membership
  const queryClient = useQueryClient();
  const [name, setName] = useState(org.name);

  const rename = useMutation({
    mutationFn: () => api<{ id: string; name: string }>("PATCH", `/api/orgs/${orgId}`, { name }),
    onSuccess: (renamed) => {
      queryClient.setQueryData<Me>(
        queryKeys.me,
        (me) => me && { ...me, orgs: me.orgs.map((o) => (o.id === renamed.id ? { ...o, name: renamed.name } : o)) }
      );
    },
  });

  if (org.role !== "owner") {
    return <p className="text-sm text-muted">Only owners can change organization settings.</p>;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />
      <Card>
        <form
          className="flex items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <TextField className="flex-1" label="Organization name" value={name} onChange={setName} required maxLength={100} />
          <Button type="submit" disabled={rename.isPending}>
            Save
          </Button>
        </form>
        <ErrorText error={rename.error} />
      </Card>
    </div>
  );
}
```

Create `dashboard/src/pages/UserSettingsPage.tsx`:

```tsx
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { SETTINGS_ERRORS, githubHref } from "../auth";
import { Alert, Button, Card, ErrorText, PageHeader, TextField } from "../components/ui";
import { queryKeys, useAuthConfig, useMe } from "../queries";

export function UserSettingsPage() {
  const me = useMe().data!;
  const config = useAuthConfig();
  const [params] = useSearchParams();
  const errorCode = params.get("error");
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const changePassword = useMutation({
    mutationFn: () =>
      api("POST", "/api/me/password", {
        ...(me.user.hasPassword ? { currentPassword } : {}),
        newPassword,
      }),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api("DELETE", "/api/me/github"),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Your account" />
      {errorCode && <Alert>{SETTINGS_ERRORS[errorCode] ?? "Something went wrong. Please try again."}</Alert>}

      <Card className="space-y-1 text-sm">
        <p className="font-medium">{me.user.name}</p>
        <p className="text-muted">{me.user.email}</p>
      </Card>

      <Card className="space-y-4">
        <h2 className="font-medium">{me.user.hasPassword ? "Change password" : "Set a password"}</h2>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            changePassword.mutate();
          }}
        >
          {me.user.hasPassword && (
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={setCurrentPassword}
              required
            />
          )}
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
            required
            minLength={8}
            maxLength={256}
          />
          <ErrorText error={changePassword.error} />
          {changePassword.isSuccess && <p className="text-sm text-muted">Password updated.</p>}
          <Button type="submit" disabled={changePassword.isPending}>
            {me.user.hasPassword ? "Change password" : "Set password"}
          </Button>
        </form>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">GitHub</h2>
        {me.user.githubConnected ? (
          <>
            <p className="text-sm text-muted">Connected. You can log in with GitHub.</p>
            {!me.user.hasPassword && (
              <p className="text-sm text-muted">Set a password first, so you can still log in after disconnecting.</p>
            )}
            <ErrorText error={disconnect.error} />
            <Button
              variant="secondary"
              onClick={() => disconnect.mutate()}
              disabled={!me.user.hasPassword || disconnect.isPending}
            >
              Disconnect GitHub
            </Button>
          </>
        ) : config.data?.github ? (
          <a
            href={githubHref("connect")}
            className="inline-flex rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-bg"
          >
            Connect GitHub
          </a>
        ) : (
          <p className="text-sm text-muted">GitHub login isn't enabled on this instance.</p>
        )}
      </Card>
    </div>
  );
}
```

Create `dashboard/src/pages/InvitePage.tsx`:

```tsx
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { AuthCard, Button, ErrorText, FullPageMessage } from "../components/ui";
import { queryKeys, useMe } from "../queries";
import type { InvitePreview, Me } from "../types";

// Public: shows the invite to anyone holding the link, then accept (logged in)
// or log in / sign up first (logged out), carrying the token along.
export function InvitePage() {
  const { token = "" } = useParams();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InvitePreview>("GET", `/api/invites/${token}`),
  });
  const me = useMe();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const accept = useMutation({
    mutationFn: () => api<{ orgId: string }>("POST", `/api/invites/${token}/accept`),
    onSuccess: ({ orgId }) => {
      const joined = { id: orgId, name: invite.data!.orgName, role: invite.data!.role };
      queryClient.setQueryData<Me>(queryKeys.me, (old) => old && { ...old, orgs: [...old.orgs, joined] });
      navigate(`/orgs/${orgId}/projects`);
    },
  });

  if (invite.error) {
    return (
      <AuthCard title="Invite unavailable">
        <p className="text-sm text-muted">{invite.error.message}</p>
        <Link className="text-sm text-accent hover:underline" to="/">
          Go home
        </Link>
      </AuthCard>
    );
  }
  if (!invite.data || me.isPending) {
    return <FullPageMessage>Loading…</FullPageMessage>;
  }

  return (
    <AuthCard title={`Join ${invite.data.orgName}`}>
      <p className="text-sm text-muted">
        You've been invited to join <strong className="text-fg">{invite.data.orgName}</strong> as {invite.data.role === "owner" ? "an owner" : "a member"}.
      </p>
      {me.data ? (
        <>
          <p className="text-sm text-muted">Signed in as {me.data.user.email}.</p>
          <ErrorText error={accept.error} />
          <Button className="w-full" onClick={() => accept.mutate()} disabled={accept.isPending}>
            Accept invite
          </Button>
        </>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <Link className="text-accent hover:underline" to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>
            Log in to accept
          </Link>
          <Link className="text-accent hover:underline" to={`/signup?invite=${token}`}>
            Create an account
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
```

In `dashboard/src/pages/OrgLayout.tsx`, replace the `TABS` constant with:

```tsx
const TABS: { path: string; label: string; ownerOnly?: boolean }[] = [
  { path: "projects", label: "Projects" },
  { path: "members", label: "Members" },
  { path: "settings", label: "Settings", ownerOnly: true },
];
```

In `dashboard/src/App.tsx`:
- Import `InvitePage`, `MembersPage`, `OrgSettingsPage` and `UserSettingsPage`.
- Add `<Route path="/invite/:token" element={<InvitePage />} />` next to `/signup`, outside `RequireAuth`.
- Inside `<Route element={<AppShell />}>`, add `<Route path="settings" element={<UserSettingsPage />} />`.
- Inside `orgs/:orgId`, add:

```tsx
            <Route path="members" element={<MembersPage />} />
            <Route path="settings" element={<OrgSettingsPage />} />
```

- [ ] **Step 4: Run all dashboard tests**

Run: `npm test -w dashboard`
Expected: PASS, all four test files.

- [ ] **Step 5: Build, lint, commit**

Run: `npm run build -w dashboard && npm run lint -w dashboard`

```bash
git add dashboard/src
git commit -m "feat(dashboard): add members, invites, invite acceptance and settings pages"
```

---

### Task 15: Docs, whole-repo verification, docker-compose smoke test

**Files:**
- Modify: `server/README.md`, `README.md`, `docs/superpowers/specs/2026-09-22-repro-api-keys-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs, plus a verified build of the Docker image.

- [ ] **Step 1: Update `server/README.md`**

Make these changes:

1. In the intro paragraph, replace "It's a small self-host service, not a hosted SaaS — you run it yourself." with: "It also serves the dashboard (`dashboard/` in this repo), where people sign up, create projects and manage API keys."
2. After the "Running it" section, add a new section:

````markdown
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
````

3. Rename "## Creating projects and API keys" to "## The admin CLI". Replace its first paragraph with: "Day-to-day, projects and keys are created in the dashboard. The admin CLI in the server image is for bootstrap and recovery. Keys are stored hashed, so a key is printed **once**, when it's created."
4. In that section's examples, change `project create "your-project-name"` to `project create --org <orgId> "your-project-name"`, both occurrences. Add before them: "Find the org id with `org list`."
5. Replace the commands table with:

```markdown
| Command                                 | What it does                                                   |
| --------------------------------------- | -------------------------------------------------------------- |
| `org list`                              | List orgs with member and project counts.                      |
| `project create --org <orgId> <name>`   | Create a project in an org, with its first API key.            |
| `project list`                          | List projects with their org and number of active keys.        |
| `key create <projectId>`                | Mint an additional key for a project.                          |
| `key list <projectId>`                  | List a project's keys (prefix, created, revoked).              |
| `key revoke <keyId>`                    | Revoke a key. Ingest rejects it immediately.                   |
| `user reset-password <email>`           | Print a new random password once and log the user out everywhere. |
```

6. Append these rows to the environment variables table:

```markdown
| `PUBLIC_URL`           | no       | `http://localhost:3000` | The dashboard's external URL. Used for the same-origin check on `/api`, `Secure` cookies (when https), invite links and the GitHub callback. |
| `SIGNUP`               | no       | `invite-only`  | `invite-only` (first user, then invite links) or `open` (anyone can sign up). |
| `GITHUB_CLIENT_ID`     | no       | —              | With `GITHUB_CLIENT_SECRET`, enables GitHub login.                        |
| `GITHUB_CLIENT_SECRET` | no       | —              | See above. Setting only one of the two fails startup.                     |
| `GITHUB_BASE_URL`      | no       | `https://github.com` | GitHub Enterprise Server URL.                                       |
| `TRUST_PROXY`          | no       | `false`        | Set `true` behind a reverse proxy so login rate limits see client IPs.    |
| `DASHBOARD_DIR`        | no       | `../dashboard/dist` next to the server | Where the built dashboard is served from.         |
```

7. In the "## API" section, add after the `/health` paragraph: "`/api/*` holds the dashboard's JSON API. It's cookie-authenticated, same-origin only, and has no CORS. See `docs/superpowers/specs/2026-09-23-repro-dashboard-accounts-design.md`."

- [ ] **Step 2: Update the root README and the API keys spec**

In `README.md`, add to the Packages list:

```markdown
- [`dashboard`](dashboard) — `@repro/dashboard`, the web dashboard (React SPA) where
  users sign up, manage orgs and members, and create projects and API keys. Built into
  and served by the server.
```

In `docs/superpowers/specs/2026-09-22-repro-api-keys-design.md`, change the first out-of-scope bullet to:
`- Tenancy / project ownership, user accounts, login — see 2026-09-23-repro-dashboard-accounts-design.md.`

- [ ] **Step 3: Verify the whole repo**

Run from the repo root:

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

Expected: every workspace builds, typechecks, lints and passes its tests. Record the test counts per workspace in the task report.

- [ ] **Step 4: Commit the docs**

```bash
git add README.md server/README.md docs/superpowers/specs/2026-09-22-repro-api-keys-design.md
git commit -m "docs: document accounts, dashboard, new env vars and CLI commands"
```

- [ ] **Step 5: Docker smoke test (with the user)**

This step needs a browser. Build and start:

```bash
docker compose down -v && docker compose up -d --build
curl -s http://localhost:3000/health
```

Expected: `{"status":"ok"}`. If `dashboard-build` fails to find a Tailwind native binding, report the exact error; don't work around it silently.

Then ask the user to walk through these steps in a browser at `http://localhost:3000`, and report the result of each:

1. Sign up. This is the bootstrap signup. They land on their org's Projects page.
2. Create a project. The key is shown once, and "Done" hides it.
3. Send a timeline with that key: `curl -s -X POST http://localhost:3000/v1/timeline -H 'Content-Type: application/json' -H 'X-Repro-Key: <key>' -d '{"sessionId":"s","reason":{"type":"manual"},"events":[],"meta":{"url":"http://x","userAgent":"curl","capturedAt":1}}'`. Expect `{"id":"..."}`.
4. Members → Create invite link. Open it in a private window and sign up with it. The new user lands in the same org as a member and sees no Settings tab.
5. As the owner, revoke the key on the project page. Repeat the `curl` from step 3 and expect `{"error":"Invalid API key"}`.
6. Reload a deep link (e.g. `/orgs/<id>/members`). The page still renders.

When the user confirms, the plan is done. Tear down with `docker compose down -v`.
