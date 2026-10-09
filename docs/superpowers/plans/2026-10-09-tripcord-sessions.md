# Tripcord Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the session the unit of a Tripcord timeline: a session holds one
merged timeline of browser- and server-authored events, events stay invisible
until a capture bakes them, a language-agnostic write API lets any backend stage
events, and `@tripcord/js/node` gives Node backends a first-class client.

**Architecture:** `sessions` rows hold `pending_events` (staged) and `events`
(baked). `POST /v1/events` stages; `POST /v1/timeline` (existing) bakes and
records a `captures` marker. Baked events are deduped by `event.id` or a content
hash. Pruning drops idle sessions (`STAGING_TTL`) and old captures
(`RETENTION_DAYS`). The browser client keeps its local ring buffer and only
changes by stamping `id`/`source`; the Node client reuses `core/` and either
stages live or buffers request-scoped.

**Tech Stack:** TypeScript, Fastify 5, Drizzle ORM 0.36 + drizzle-kit 0.28,
`pg`, Vitest 2 + testcontainers, React 18, React Router 7, TanStack Query 5,
Tailwind CSS 4, tsup, ESLint flat config.

**Spec:** `docs/superpowers/specs/2026-10-09-tripcord-sessions-design.md`

## Global Constraints

- **No new infrastructure.** Staging is Postgres only (`sessions.pending_events`
  jsonb). No Redis, no in-memory session store on the app server.
- **No flush handshake.** No `/.tripcord/flush` endpoint, no framework
  middleware. Both sides write to Tripcord; a capture bakes the session.
- **Additive ingest schema.** `/v1/timeline` and `/v1/events` only ever gain
  optional fields, so older clients keep working.
- **Bake is one transaction.** Drain `pending_events`, merge, dedupe, sort, cap,
  write `sessions.events`, insert `captures` — or none of it.
- **Dedupe key:** `event.id`, else `sha256(JSON.stringify([timestamp, type, name, data ?? null]))`.
- **`source` defaults to `"server"` on `/v1/events`.** The browser adapter sends
  `"browser"` explicitly.
- **Auth:** `X-Tripcord-Key` or `Authorization: Bearer`. No `?key=`.
- **`sessionId`:** 1–200 characters.
- **`MAX_SESSION_EVENTS`:** 500; oldest dropped past the cap.
- **`STAGING_TTL`:** default `24h`. Baked sessions are swept by the same job.
- **`captures.session_id` is text, never an FK** — pruning a session must not
  touch its captures.
- **Everything client-supplied is rendered as text.** `meta.url` links only for
  `http:`/`https:`. No `dangerouslySetInnerHTML`.
- **Old data is migrated, not kept in parallel.** `timelines` is dropped.
- **Commits:** one per task, conventional style (`feat(server): …`,
  `feat(js): …`, `feat(dashboard): …`, `docs: …`), no AI attribution.

## Review Focus

These are the cases most likely to be wrong while the happy path passes. Each
has a pinned test in the task named.

1. **Two captures in one session never duplicate events.** The browser re-sends
   its whole buffer each capture; merge-dedupe by `id`/content must collapse it.
   (Tasks 2, 3)
2. **A staged event isn't lost to a capture race.** A capture that runs while an
   event is being staged must see it or the event must stage after; the session
   row lock, and draining with `RETURNING`, must not drop either. (Task 2)
3. **`Authorization: Bearer` and `X-Tripcord-Key` resolve identically**, and a
   request with both uses one lookup, not two. (Task 3)
4. **Pruning leaves captures alone.** Deleting an idle session must not remove
   its `captures` rows, and a capture must still list after its session is gone.
   (Tasks 2, 4, 5)
5. **Migration dedupes across old rows.** Several `timelines` rows for one
   `session_id` become one session with a deduped event set and several capture
   markers. (Task 6)
6. **`@tripcord/js` still no-ops without a browser.** The new `id`/`source`
   stamping must not touch `window`/`document`/`sessionStorage` from `core/`.
   (Task 7)

## Prerequisites

From the repo root, once: `npm install`. Docker must be running for server and
dashboard tests.

Commands:
- Server: `npm test -w server -- src/db/sessions.test.ts`
- Client: `npm test -w packages/js`
- Dashboard: `npm test -w dashboard`
- Whole repo: `npm run build && npm run typecheck && npm run lint && npm test`

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `server/src/db/schema.ts` | modify | add `sessions`, `captures`; remove `timelines` |
| `server/drizzle/0007_sessions.sql` + `meta/*` | generate | create tables, migrate rows, drop `timelines` |
| `server/src/db/sessions.ts` | create | `stageEvents`, `bakeCapture`, `createSession`, `pruneSessions` |
| `server/src/db/sessions.test.ts` | create | DB-level staging/baking/dedupe/prune |
| `server/src/db/event-hash.ts` | create | `eventDedupeKey`, `mergeEvents` (pure, unit-tested) |
| `server/src/routes/events.ts` | create | `POST /v1/events`, `POST /v1/sessions` |
| `server/src/routes/timeline.ts` | modify | `POST /v1/timeline` bakes; shared key auth |
| `server/src/routes/ingest-auth.ts` | create | `resolveProject` (header or Bearer) shared by both routes |
| `server/src/retention.ts` | modify | prune sessions; drop timelines cleanup |
| `server/src/config.ts` | modify | `STAGING_TTL`, `MAX_SESSION_EVENTS` |
| `server/src/db/timelines.ts` → `server/src/db/session-reads.ts` | rename/modify | session list/detail/summary/tags |
| `server/src/routes/timelines.ts` | modify | session list/detail routes |
| `packages/js/src/core/types.ts` | modify | `TimelineEvent.id?`, `.source?` |
| `packages/js/src/core/tracer.ts` | modify | stamp `id` + `source` |
| `packages/js/src/core/ids.ts` | create | `randomId()` with fallback |
| `packages/js/src/browser/createTracer.ts` | modify | `source: "browser"` |
| `packages/js/src/node/*` | create | Node tracer, transport, entry |
| `packages/js/src/node.ts` | create | `@tripcord/js/node` entry |
| `packages/js/package.json`, `tsup.config.ts` | modify | `./node` export |
| `dashboard/src/**` | modify | session list + detail with source chips |
| `README.md`, `packages/js/README.md`, `server/README.md` | modify | docs + versions |

---

### Task 1: Event merge primitives (pure)

**Files:**
- Create: `server/src/db/event-hash.ts`
- Test: `server/src/db/event-hash.test.ts`

**Interfaces:**
- Produces:
  - `eventDedupeKey(event: TimelineEvent): string`
  - `mergeEvents(lists: TimelineEvent[][], cap?): TimelineEvent[]` — dedupes,
    sorts ascending by `timestamp`, keeps the newest `cap` (default: no limit).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { eventDedupeKey, mergeEvents } from "./event-hash";

const ev = (over: Partial<import("@tripcord/js").TimelineEvent> = {}) => ({
  timestamp: 1, type: "custom" as const, name: "a", ...over,
});

describe("eventDedupeKey", () => {
  it("prefers id", () => {
    expect(eventDedupeKey(ev({ id: "x" }))).toBe("x");
  });
  it("falls back to a content hash that ignores key order", () => {
    expect(eventDedupeKey(ev({ data: { a: 1, b: 2 } })))
      .toBe(eventDedupeKey(ev({ data: { b: 2, a: 1 } })));
  });
  it("changes with timestamp", () => {
    expect(eventDedupeKey(ev({ timestamp: 1 }))).not.toBe(eventDedupeKey(ev({ timestamp: 2 })));
  });
});

describe("mergeEvents", () => {
  it("dedupes by id across lists and sorts by timestamp", () => {
    const merged = mergeEvents([
      [ev({ id: "a", timestamp: 2 }), ev({ id: "b", timestamp: 1 })],
      [ev({ id: "a", timestamp: 2 }), ev({ id: "c", timestamp: 3 })],
    ]);
    expect(merged.map((e) => e.id)).toEqual(["b", "a", "c"]);
  });
  it("drops the oldest past cap", () => {
    const list = [1, 2, 3, 4].map((timestamp) => ev({ id: `e${timestamp}`, timestamp }));
    expect(mergeEvents([list], 3).map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npm test -w server -- src/db/event-hash.test.ts`

- [ ] **Step 3: Implement**

```ts
import { createHash } from "node:crypto";
import type { TimelineEvent } from "@tripcord/js";

/** Canonical JSON: object keys sorted at every level. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function eventDedupeKey(event: TimelineEvent): string {
  if (event.id) return event.id;
  const canonical = stableStringify([event.timestamp, event.type, event.name, event.data ?? null]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function mergeEvents(lists: TimelineEvent[][], cap = Number.POSITIVE_INFINITY): TimelineEvent[] {
  const byKey = new Map<string, TimelineEvent>();
  for (const list of lists) {
    for (const event of list) {
      const key = eventDedupeKey(event);
      if (!byKey.has(key)) byKey.set(key, event);
    }
  }
  const sorted = [...byKey.values()].sort((a, b) => a.timestamp - b.timestamp);
  return cap === Number.POSITIVE_INFINITY ? sorted : sorted.slice(-cap);
}
```

> Note: the content hash sorts object keys at every level (a plain
> `JSON.stringify` does not), so `{a:1,b:2}` and `{b:2,a:1}` dedupe. This is why
> the pure module is written first — Tasks 2 and 6 both depend on it.

- [ ] **Step 4: Run it, expect PASS**
- [ ] **Step 5: Commit** — `feat(server): event merge primitives`

---

### Task 2: `sessions` data access (stage, bake, prune)

**Files:**
- Create: `server/src/db/sessions.ts`
- Test: `server/src/db/sessions.test.ts`
- Modify: `server/src/db/schema.ts` (add `sessions`, `captures`; keep `timelines`
  until Task 6's migration lands, so the build stays green)

**Interfaces:**
- Produces:
  - `stageEvents(db, projectId, sessionId, events): Promise<number>`
  - `createSession(db, projectId, sessionId): Promise<void>`
  - `bakeCapture(db, projectId, input: { sessionId; reason; events; meta; tags; occurredAt }): Promise<{ id: string; eventCount: number }>`
  - `pruneSessions(db, stagingTtlMs): Promise<number>`

- [ ] **Step 1: Write the failing test** (`src/db/sessions.test.ts`, using the
  existing testcontainers fixture/`resetDb` — see `src/db/timelines.test.ts`)

Key cases (pinned to Review Focus 1 & 2):

```ts
it("stages without baking", async () => {
  await stageEvents(db, project.id, "s1", [event({ id: "a", timestamp: 1 })]);
  expect(await sessionRow(db, project.id, "s1")).toMatchObject({ events: [] });
  expect((await sessionRow(db, project.id, "s1")).pendingEvents).toHaveLength(1);
});

it("bakes staged + payload events, deduped and sorted", async () => {
  await stageEvents(db, project.id, "s1", [event({ id: "a", timestamp: 2 })]);
  const { eventCount } = await bakeCapture(db, project.id, {
    sessionId: "s1", reason: { type: "manual", name: "boom" },
    events: [event({ id: "a", timestamp: 2 }), event({ id: "b", timestamp: 1 })],
    meta: meta(), tags: [], occurredAt: new Date(),
  });
  expect(eventCount).toBe(2);
  const row = await sessionRow(db, project.id, "s1");
  expect(row.events.map((e) => e.id)).toEqual(["b", "a"]);
  expect(row.pendingEvents).toEqual([]);
});

it("two captures in one session don't duplicate the browser buffer", async () => {
  const buffer = [event({ id: "a", timestamp: 1 }), event({ id: "b", timestamp: 2 })];
  await bakeCapture(db, project.id, { sessionId: "s1", reason: { type: "manual" }, events: buffer, meta: meta(), tags: [], occurredAt: new Date() });
  await bakeCapture(db, project.id, { sessionId: "s1", reason: { type: "manual" }, events: buffer, meta: meta(), tags: [], occurredAt: new Date() });
  expect((await sessionRow(db, project.id, "s1")).events).toHaveLength(2);
});

it("caps a session at MAX_SESSION_EVENTS", async () => { /* 3 events, cap 2 → oldest dropped */ });

it("prunes idle sessions but not captures", async () => {
  await bakeCapture(db, project.id, { sessionId: "s1", reason: { type: "manual" }, events: [], meta: meta(), tags: [], occurredAt: new Date() });
  await db.update(sessions).set({ updatedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(sessions.sessionId, "s1"));
  await pruneSessions(db, 3600_000);
  expect(await sessionRow(db, project.id, "s1")).toBeUndefined();
  expect(await db.select().from(captures).where(eq(captures.sessionId, "s1"))).toHaveLength(1);
});
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement `sessions.ts`**

```ts
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "./client";
import { captures, sessions } from "./schema";
import { mergeEvents } from "./event-hash";
import type { TimelineEvent, TimelineReason, TimelineMeta } from "@tripcord/js";

const MAX_SESSION_EVENTS = 500;

export async function stageEvents(db: Database, projectId: string, sessionId: string, events: TimelineEvent[]): Promise<number> {
  const incoming = events.map((e) => ({ ...e, source: e.source ?? "server" }));
  await db
    .insert(sessions)
    .values({ projectId, sessionId, pendingEvents: incoming })
    .onConflictDoUpdate({
      target: [sessions.projectId, sessions.sessionId],
      set: {
        pendingEvents: sql`${sessions.pendingEvents} || ${JSON.stringify(incoming)}::jsonb`,
        updatedAt: sql`now()`,
      },
    });
  return incoming.length;
}

// bake: the lock + drain + merge + write happen in one transaction.
export async function bakeCapture(db, projectId, input): Promise<{ id: string; eventCount: number }> {
  return db.transaction(async (tx) => {
    await tx.insert(sessions).values({ projectId, sessionId: input.sessionId }).onConflictDoNothing();
    const [row] = await tx
      .update(sessions)
      .set({ pendingEvents: sql`'[]'::jsonb`, updatedAt: sql`now()` })
      .where(and(eq(sessions.projectId, projectId), eq(sessions.sessionId, input.sessionId)))
      .returning({ pendingEvents: sessions.pendingEvents, events: sessions.events });

    const merged = mergeEvents(
      [row.events as TimelineEvent[], row.pendingEvents as TimelineEvent[], input.events],
      MAX_SESSION_EVENTS
    );
    await tx.update(sessions).set({ events: merged }).where(and(eq(sessions.projectId, projectId), eq(sessions.sessionId, input.sessionId)));

    const [capture] = await tx.insert(captures).values({
      projectId, sessionId: input.sessionId,
      reasonType: input.reason.type, reason: input.reason, meta: input.meta,
      tags: input.tags, occurredAt: input.occurredAt,
    }).returning({ id: captures.id });
    return { id: capture.id, eventCount: merged.length };
  });
}

export async function pruneSessions(db: Database, stagingTtlMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - stagingTtlMs);
  const deleted = await db.delete(sessions).where(lt(sessions.updatedAt, cutoff)).returning({ id: sessions.id });
  return deleted.length;
}
```

> The `UPDATE … RETURNING` both locks and drains; a concurrent stage waits on the
> row and its event lands in `pendingEvents` after the drain, ready for the next
> bake. That's Review Focus 2.

- [ ] **Step 4: Run it, expect PASS**
- [ ] **Step 5: Commit** — `feat(server): session staging and bake`

---

### Task 3: Ingest routes — `/v1/events`, `/v1/sessions`, bake in `/v1/timeline`

**Files:**
- Create: `server/src/routes/ingest-auth.ts`
- Create: `server/src/routes/events.ts`
- Test: `server/src/routes/events.test.ts`
- Modify: `server/src/routes/timeline.ts`
- Modify: `server/src/app.ts` (register the new routes in the `/v1` plugin)

**Interfaces:**
- Consumes: `stageEvents`, `bakeCapture`, `createSession` (Task 2).
- Produces: `resolveProject(request, reply, db, invalidKeys): Promise<boolean>`
  — reads `X-Tripcord-Key` or `Authorization: Bearer`, applies the invalid-key
  limiter, sets `request.project`.

- [ ] **Step 1: Write the failing tests**

```ts
it("stages via /v1/events and does not list a capture", async () => { /* POST, then read API empty */ });
it("bakes on /v1/timeline and includes staged server events", async () => {
  await post("/v1/events", { sessionId: "s1", events: [event({ name: "server.step" })] });
  const res = await post("/v1/timeline", payload({ sessionId: "s1", events: [event({ name: "browser.step" })], reason: { type: "manual" } }));
  // session events == [browser.step, server.step] sorted
});
it("accepts Authorization: Bearer", async () => { /* same key, no X-Tripcord-Key */ });
it("401s with no key and with both headers absent", async () => {});
it("400s an unknown event field", async () => {});
it("mints via /v1/sessions", async () => { expect((await post("/v1/sessions", {})).json().sessionId).toMatch(/^[0-9a-f-]{36}$/); });
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

`ingest-auth.ts`:

```ts
export function readApiKey(headers): string | undefined {
  const raw = headers["x-tripcord-key"];
  if (typeof raw === "string" && raw) return raw;
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}
```

Factor the `preValidation` and rate-limit config out of `timeline.ts` into a
shared helper both routes use, so the "invalid key" limiter is one instance.

`events.ts` adds the event schema (`additionalProperties: false`, optional
`id`/`source`), `POST /v1/events` (`202`), `POST /v1/sessions` (`201`).
`timeline.ts`'s handler becomes `bakeCapture(...)` and returns
`201 { id, sessionId, eventCount }`.

- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** — `feat(server): event staging and capture-bake ingest`

---

### Task 4: Retention, config, and the pruning job

**Files:**
- Modify: `server/src/config.ts`, `server/src/retention.ts`, `server/src/index.ts`
- Test: `server/src/retention.test.ts`, `server/src/config.test.ts`

**Interfaces:**
- Config gains `stagingTtlMs: number` (from `STAGING_TTL`, default 24h;
  `parseDuration` reused if present, else add one).
- `runCleanup(db, retentionDays, emailVerification, stagingTtlMs)`.
- Remove `cleanupOldTimelines`; add `pruneSessions`.

- [ ] **Step 1: Failing test** — a session idle past the TTL is deleted; one
  updated now survives; captures in both are untouched. Config: `STAGING_TTL=1h`
  parses; a bad value fails startup.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — swap the timelines step for `pruneSessions`;
  thread `stagingTtlMs` through `scheduleCleanup`.
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** — `feat(server): prune idle sessions`

---

### Task 5: Read API — session list, detail, summary, tags

**Files:**
- Rename: `server/src/db/timelines.ts` → `server/src/db/session-reads.ts`
  (or keep the filename and change internals; pick one and update imports)
- Modify: `server/src/routes/timelines.ts`
- Test: `server/src/db/session-reads.test.ts`, `server/src/routes/timelines.test.ts`,
  `server/src/routes/isolation.test.ts`

**Interfaces:**
- `listSessions(db, projectId, filters, page)` →
  `{ sessions: [{ sessionId, firstSeenAt, lastSeenAt, reasonTypes, url, tags, eventCount, captureCount }], nextCursor }`.
  A session is included only if it has ≥1 capture in range.
- `getSession(db, projectId, sessionId)` →
  `{ session, captures }` or `undefined`.
- `summarizeTimelines` / `listTags` keep their shapes, counting `captures`.

- [ ] **Step 1: Failing tests** — list filters by `reasonType`/`tag`/`reason`
  against captures and returns distinct sessions with `captureCount`;
  keyset pagination on `(lastSeenAt, sessionId)`; detail merges `sessions.events`
  and lists capture markers; a session in another project is `404`; isolation
  `CASES` gains the two changed routes.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — the session list is a `captures` aggregate joined
  to `sessions` for `events`/`updated_at`; `lastSeenAt = max(captures.occurred_at)`.
  The `reason` key still hashes `(reason_type, name, message)`.
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** — `feat(server): session read API`

---

### Task 6: Migration — create tables, convert `timelines`, drop it

**Files:**
- Generate: `server/drizzle/0007_sessions.sql` + `meta/*` via `drizzle-kit`.
- Modify: `server/src/db/schema.ts` (delete `timelines`).
- Test: `server/src/db/migrate.test.ts`

**Interfaces:**
- Consumes `mergeEvents` for migration-time dedupe (run in a one-off script or
  directly in SQL — a data migration in SQL is fine, but a Node step that reads
  old rows and calls `bakeCapture` is clearer; choose the Node step).

- [ ] **Step 1: Failing test** — seed old `timelines` rows (two sharing a
  `session_id`, with an overlapping event), run the migration, assert one
  `sessions` row with the deduped event set and two `captures`; `timelines`
  table is gone.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — drizzle migration creates `sessions`/`captures`,
  then runs the row conversion, then drops `timelines`. Update `schema.ts` and
  remove all `timelines` imports (grep for `timelines` across `src/`).
- [ ] **Step 4: Run, expect PASS** — then `npm run build -w server && npm run typecheck -w server`
- [ ] **Step 5: Commit** — `feat(server): migrate timelines into sessions and captures`

---

### Task 7: `@tripcord/js` — stamp `id` and `source`

**Files:**
- Create: `packages/js/src/core/ids.ts`, `packages/js/src/core/ids.test.ts`
- Modify: `packages/js/src/core/types.ts`, `packages/js/src/core/tracer.ts`,
  `packages/js/src/core/tracer.test.ts`, `packages/js/src/browser/createTracer.ts`

**Interfaces:**
- `randomId(): string` — `crypto.randomUUID()` when present, hex fallback.
- `TracerConfig.source?: string`; every pushed event gets `id: randomId()` and
  `...(source ? { source } : {})`.
- Browser passes `source: "browser"`.

- [ ] **Step 1: Failing tests** — every `track`/`traceElement`/error event has an
  `id`; with `source: "browser"` each event carries `source: "browser"`;
  `randomId` works with no `crypto`.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — `ids.ts`, then stamp in `core/tracer.ts`'s
  `pushEvent`; thread `source` from the browser adapter.
- [ ] **Step 4: Run, expect PASS** — and the full client suite (no `core/`
  browser-global regression; the ESLint boundary rule stays green).
- [ ] **Step 5: Commit** — `feat(js): stamp event ids and source`

---

### Task 8: `@tripcord/js/node`

**Files:**
- Create: `packages/js/src/node/transport.ts`, `session.ts`, `createTracer.ts`,
  `index.ts`, `createTracer.test.ts`
- Create: `packages/js/src/node.ts` (entry re-export)
- Modify: `packages/js/package.json` (add `./node` export), `packages/js/tsup.config.ts`
  (add `node` entry)
- Test: `packages/js/src/dist-smoke.test.ts` (extend for `./node`)

**Interfaces:**
- `createTracer(config: NodeTracerConfig): NodeTracer`
  - `NodeTracerConfig`: `{ endpoint; apiKey; sessionId?; stageEvents?; maxEvents?; seedEvents?; meta? }`.
  - `NodeTracer`: `track`, `capture`, `setTags`, `clearTags`, `getSessionId`,
    `getEvents`, `flush`.
- `createSessionId(): string` (reuses `core/ids.ts`).

- [ ] **Step 1: Failing tests** (Node env, stubbed `fetch`)

```ts
it("track() stages to /v1/events with source server", async () => { /* assert fetch url/body */ });
it("capture() posts /v1/timeline with the reason and no events when staging", async () => {});
it("capture() includes the local buffer when stageEvents is false", async () => {});
it("getSessionId/getEvents expose what was tracked", async () => {});
it("flush() awaits in-flight sends; a failed send warns and never throws", async () => {});
```

- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — reuse `core/createTracer` with a `send` that POSTs
  the capture, `source: "server"`, and a `flush` that tracks in-flight promises.
  `track` calls the staging transport and the core buffer (so `getEvents` works).
  `tsup` adds `node: "src/node.ts"`; `package.json` adds the export mirroring
  `./react`.
- [ ] **Step 4: Run, expect PASS**; build and exec the built `dist/node.js` to
  prove no browser globals.
- [ ] **Step 5: Commit** — `feat(js): add @tripcord/js/node`

---

### Task 9: Dashboard — session list and merged detail

**Files:**
- Modify: `dashboard/src/api.ts`, `queries.ts`, `types.ts`, `timelineFilters.ts`
- Modify: `dashboard/src/pages/TimelinesPage.tsx`, `TimelinePage.tsx`
- Modify: `dashboard/src/components/timelines/*`
- Modify: `dashboard/src/index.css` (source color tokens)
- Test: `dashboard/src/pages/timelines.test.tsx`, `timeline.test.tsx`

**Interfaces:**
- The list consumes `{ sessions: [...] }`; the route param becomes `sessionId`.

- [ ] **Step 1: Failing tests** — the list shows `captureCount`/`eventCount` and
  reason chips; the detail renders `session.events` ordered with a **source
  chip** per event and capture markers highlighted; a `javascript:` `meta.url`
  is not a link.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement** — add `--color-source-browser` /
  `--color-source-server` (light + dark) in `index.css`, a `SourceChip`, and
  merge the capture markers into the event stream at `occurred_at`.
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** — `feat(dashboard): session timeline with source chips`

---

### Task 10: Docs and versions

**Files:**
- Modify: `README.md`, `packages/js/README.md`, `server/README.md`
- Modify: `packages/js/package.json` (`0.3.0`), `server/package.json` (`0.4.0`)
- Modify: `docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md`,
  `docs/superpowers/specs/2026-09-22-repro-client-library-design.md` (supersede notes)

- [ ] **Step 1: Docs** — describe `/v1/events`, `/v1/sessions`, capture-bake,
  `Bearer`, `STAGING_TTL`, `@tripcord/js/node`, `source`/`id`, staging vs
  capture, the seed fallback. Remove "SSR/Node adapter" from the README's
  not-yet list. Add "Superseded by 2026-10-09 sessions" notes to the two old
  specs.
- [ ] **Step 2: Versions** — bump both packages.
- [ ] **Step 3: Full suite** — `npm run build && npm run typecheck && npm run lint && npm test`
- [ ] **Step 4: Commit** — `docs: sessions, server events, and the Node client`

---

## Manual smoke (before release)

With `docker compose up -d --build`:

```bash
KEY=tpk_…    # from the dashboard
# stage a server event
curl -s -X POST http://localhost:3000/v1/events \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","events":[{"timestamp":1,"type":"custom","name":"server.step","source":"server"}]}'
# nothing in the dashboard yet
# trip it
curl -s -X POST http://localhost:3000/v1/timeline \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"sessionId":"smoke","reason":{"type":"manual","name":"smoke"},"events":[{"timestamp":2,"type":"custom","name":"browser.step","source":"browser"}],"meta":{"url":"http://x","userAgent":"curl","capturedAt":2}}'
```

The session appears once, with `browser.step` and `server.step` in order and
distinct source chips. Re-send the same capture: no duplicate events. Wait past
`STAGING_TTL` with a staged-but-uncaptured session: it disappears.
