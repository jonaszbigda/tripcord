# Tripcord — sessions, server events & the Node client

Status: approved
Date: 2026-10-09
Scope: make the **session** the unit of a timeline, add a language-agnostic write
API for arbitrary backends, add `@tripcord/js/node`, and merge browser- and
server-authored events into one session timeline that is only "baked" (made
visible) when something trips it.

## Problem & concept

Today a timeline is **one flush**. The browser keeps a ring buffer in
`sessionStorage` and, on a capture, POSTs the whole buffer plus a reason to
`POST /v1/timeline`, stored as a single `timelines` row. "Session" is only a
`session_id` string; the dashboard links rows that share it as siblings
(`server/src/db/timelines.ts`).

Two things are missing:

1. **Server-authored breadcrumbs.** A backend (Node, Python, .NET, anything) has
   no way to say "this happened in session X". Server events and browser events
   for the same user are never part of one timeline.
2. **A session that grows.** Marking an event "at any moment" and having it join
   the session's timeline isn't possible — every write is a separate,
   self-contained row.

This spec adds both, while keeping Tripcord's defining property: **nothing is
made visible until something trips it.** Events are *staged*; a capture *bakes*
them. Staged events that never get baked are pruned, so a quiet database doesn't
grow without bound.

## Decisions

| Question | Decision |
| --- | --- |
| Unit of a timeline | A **session**. One session = one merged timeline, across browser and server sources. |
| What a capture is | A **marker** (a reason) on the session, not a copy of the events. |
| When events become visible | Only on a capture ("bake"). Until then they are staged. |
| Where staging lives | Tripcord, in Postgres, as one `pending_events` jsonb per session — not one row per event, not Redis. |
| Who flushes | Nobody handshakes. Both browser and server write to Tripcord directly; a capture from either bakes the session. |
| Pruning | Staged-but-unbaked events are dropped after `STAGING_TTL`; baked sessions are kept for `RETENTION_DAYS`. |
| Who mints a session id | The caller. Any opaque string is accepted; both libraries ship a UUID helper. |
| Duplicate events | Deduped at bake by `event.id ?? hash(timestamp, type, name, data)`. |
| Auth | `X-Tripcord-Key` (existing) or `Authorization: Bearer <key>`. |
| Node package | `@tripcord/js/node` subpath, not a sibling package. |
| Old data | Migrated: each `timelines` row becomes a baked session + a capture marker. `timelines` is dropped. |

## Data model (Postgres, via Drizzle)

```ts
// Named timeline_sessions, not sessions: `sessions` is already the table of
// cookie login sessions (auth/sessions).
export const timelineSessions = pgTable("timeline_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull(),
  // Staged, invisible until a capture. Deduped by id.
  pendingEvents: jsonb("pending_events").notNull().default(sql`'[]'::jsonb`),
  // Baked, visible. The session's whole timeline, oldest first, deduped by id.
  events: jsonb("events").notNull().default(sql`'[]'::jsonb`),
  // Set on every write (stage or bake); drives pruning.
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  projectSessionUq: unique().on(table.projectId, table.sessionId),
  projectUpdatedIdx: index("timeline_sessions_project_updated_idx").on(table.projectId, table.updatedAt),
}));

export const captures = pgTable("captures", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull(),
  reasonType: text("reason_type").notNull(),
  reason: jsonb("reason").notNull(),
  meta: jsonb("meta").notNull(),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  // When the moment happened (from the payload), and when we stored it.
  occurredAt: timestamp("occurred_at").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
}, (table) => ({
  projectReceivedIdx: index("captures_project_received_idx").on(table.projectId, table.receivedAt),
  projectReasonTypeIdx: index("captures_project_reason_type_idx").on(table.projectId, table.reasonType),
  projectSessionIdx: index("captures_project_session_idx").on(table.projectId, table.sessionId),
  tagsIdx: index("captures_tags_idx").using("gin", table.tags),
}));
```

Notes:

- **Events live on the session, not on the capture.** A capture is a marker; the
  timeline it belongs to is `timeline_sessions.events`. This is what makes "all events in
  one session are one timeline" true, and it means two captures in a session
  never duplicate events — they dedupe on bake.
- **`timeline_sessions` are pruned, `captures` are not (until retention).** A capture's
  `session_id` is text, not a foreign key, so pruning the session row never
  orphans a capture. The dashboard can still group captures by `session_id` even
  for a session row that has been pruned.
- **A session is visible in the dashboard once it has at least one capture.**
  This recovers "no noise, only signal" without holding anything back at write
  time: event-only sessions exist in Postgres but are not listed.
- **`sessionId` is bounded**: 1–200 characters, the same ceiling the read API's
  cursor uses today (`routes/timelines.ts`).

### Events

`TimelineEvent` (`packages/js/src/core/types.ts`) gains two optional fields:

```ts
interface TimelineEvent {
  id?: string;      // dedupe key; both libraries set it
  source?: string;  // "browser" | "server" | anything else
  timestamp: number;
  type: "custom" | "error" | "unhandledrejection" | "trace";
  name: string;
  data?: Record<string, unknown>;
}
```

Both are additive: an old client that sends neither keeps working, and the
ingest schema only gains optional properties (the existing compatibility rule).

**Dedupe key** at bake, in order: `event.id`, else
`sha256(JSON.stringify([timestamp, type, name, data ?? null]))`. So a migrated
event with no id, or a repeated browser buffer, collapses to one entry while a
genuinely new occurrence (different `timestamp`) does not.

## Staging & baking

### `POST /v1/events` — stage

Request:

```json
{
  "sessionId": "…",
  "events": [
    { "id": "…", "timestamp": 1700000000000, "type": "custom", "name": "…", "data": {}, "source": "server" }
  ]
}
```

- Upserts the session (`INSERT … ON CONFLICT (project_id, session_id) DO UPDATE
  SET pending_events = timeline_sessions.pending_events || $events, updated_at = now()`).
- `source` is optional; the endpoint defaults a missing `source` to `"server"`.
- **Not visible.** Nothing is baked.
- Response: `202 { sessionId, staged: <n> }`.

### `POST /v1/timeline` — capture & bake

The existing payload shape is kept (`TimelinePayload`: `sessionId`, `reason`,
`events`, `meta`, `tags?`). It now means "record a moment and bake the session".
`events` may be empty.

Within one transaction:

1. `SELECT … FOR UPDATE` the session, creating it if absent.
2. Drain staged events: `UPDATE sessions SET pending_events = '[]',
   updated_at = now() … RETURNING pending_events, events`.
3. Merge `old events ∪ pending events ∪ payload.events`, dedupe by key, sort by
   `timestamp` ascending, cap at `MAX_SESSION_EVENTS` (drop oldest).
4. `UPDATE sessions SET events = $merged`.
5. `INSERT INTO captures (…, occurred_at = least(now(), payload.meta.capturedAt))`.
   The clamp only stops a client clock that's ahead from future-dating a
   capture; a **backdated** `capturedAt` is kept as-is, so a capture can
   describe a moment from days ago.
6. Response: `201 { id, sessionId, eventCount }`.

The cap bounds a single session's jsonb. Default `MAX_SESSION_EVENTS = 500`;
past it the oldest are dropped (the reason is always the newest marker, and the
browser only ever keeps 50 breadcrumbs anyway).

### `POST /v1/sessions` — mint (convenience, optional to use)

`201 { sessionId }` — a server-minted UUID, so a non-Node backend can create an
id to hand to the browser. The row is empty and is pruned by `STAGING_TTL` if it
never receives anything.

## Auth

Every `/v1/*` route accepts the key as either:

- `X-Tripcord-Key: tpk_…` (existing, what `@tripcord/js` sends), or
- `Authorization: Bearer tpk_…` (ergonomic for `curl`/Postman/other languages).

Both resolve through the same hashed lookup (`db/projects.ts`). A request with
neither header, or an unknown/revoked key, is `401 { error: "Invalid API key" }`,
after the existing per-IP invalid-key limiter. No `?key=` query parameter: query
strings leak into access logs and proxies.

## Pruning & retention

One scheduled job (the existing in-process timer, `server/src/retention.ts`)
does both:

- `DELETE FROM sessions WHERE updated_at < now() - STAGING_TTL` — drops staged
  events that were never baked, **and** any session with no recent activity.
  Because it keys on `updated_at`, a session with recent activity survives.
- `DELETE FROM captures WHERE received_at < now() - RETENTION_DAYS` — unchanged
  semantics from today.

New env var:

| Var | Default | Purpose |
| --- | --- | --- |
| `STAGING_TTL` | `24h` | How long unbaked events / idle sessions are kept. |

Baked events live on the session row, so they are governed by the **same**
`STAGING_TTL` sweep, not `RETENTION_DAYS`. That is deliberate: once a session has
been pruned, its baked timeline is gone, but its `captures` markers remain for
`RETENTION_DAYS` and the dashboard can still list and filter them. (If we later
want baked timelines to outlive the staging TTL, `timeline_sessions.updated_at` can be set
to the bake time and the sweep split in two — out of scope now.)

## Client: browser (`@tripcord/js`)

- `core/types.ts`: `TimelineEvent` gains `id?` and `source?`.
- `core/tracer.ts`: `createTracer` takes a new `source?: string` on its config;
  every event it pushes gets `id: randomId()` and `source`, when set. This is the
  one place events are stamped, so both adapters behave identically.
- `browser/createTracer.ts`: passes `source: "browser"`.
- No other browser behavior changes: the ring buffer, `sessionStorage`,
  `setTags`, the error hooks and `data-trace` are untouched. `init({ sessionId,
  seedEvents })` keeps working exactly as designed.
- `seedEvents` is now a **fallback** (see below), documented as such.

## Client: Node (`@tripcord/js/node`)

New subpath export, reusing `core/` unchanged. Config:

```ts
import { createTracer } from "@tripcord/js/node";

const tracer = createTracer({
  endpoint: "https://tripcord.example.com/v1/timeline",
  apiKey: "tpk_…",
  sessionId: req.sessionId,     // any id; createSessionId() helper if you need one
  stageEvents: true,            // default: post each track() to /v1/events immediately
  meta: { url: req.url, userAgent: req.headers["user-agent"] },
});
```

- `track(name, data?)` → with `stageEvents` (default), `POST /v1/events`
  immediately, `source: "server"`. Also appended to an in-memory buffer so
  `getEvents()` can seed a page.
- `capture(name?, data?, options?)` → `POST /v1/timeline` with
  `events: stageEvents ? [] : <local buffer>` and the reason. So a request-scoped
  SSR tracer (`stageEvents: false`) buffers and ships on its own capture, while a
  long-lived backend stages live and only sends a marker on capture.
- `setTags` / `clearTags` as in the browser.
- `getSessionId(): string` and `getEvents(): TimelineEvent[]` — for serializing
  `{ sessionId, seedEvents }` into an HTML page.
- `flush(): Promise<void>` — awaits any in-flight sends, so a server can
  guarantee delivery before it responds. Sends are fire-and-forget by default
  (`console.warn` on failure), matching the browser.
- Transport uses global `fetch` (Node 18+), no `keepalive`. No `window`,
  `document` or `sessionStorage` access.

### SSR correlation & the handshake that isn't needed

Three flows, all supported because the API is unopinionated about the id:

1. **Browser mints → server.** The browser id travels in a cookie/header; the
   Node tracer is constructed with it. Both write to the same session.
2. **Server mints → browser.** The Node tracer mints (or `createSessionId()`),
   the app serializes `{ sessionId, seedEvents }`, and the browser
   `init({ sessionId, seedEvents })` adopts both.
3. **The app mints.** Use a domain id (order, job) as the session id.

**Why there is no flush handshake.** In this model the server has no buffer to
flush: with `stageEvents` it has already posted each event to Tripcord. A capture
from either side is a write to Tripcord, and Tripcord bakes the session's staged
events at that instant. So the browser never has to signal the app server, there
is no `/.tripcord/flush` endpoint, no framework middleware, and no ordering
problem — everything is ordered by `timestamp`. The "if the server doesn't
implement Tripcord, no-op" property is automatic: there is simply nothing staged.

**Seeding is a fallback.** It is only needed when the server does **not** stage
to Tripcord (no reachable Tripcord, or `stageEvents: false`) and the app wants
the browser to carry server breadcrumbs. If an app both stages *and* seeds the
same events, the bake-time dedupe by `id`/content prevents doubles.

## Read API (dashboard)

Base path unchanged: `/api/orgs/:orgId/projects/:projectId/…`. The tenant
isolation test's `CASES` table is updated for every touched route.

- `GET …/timelines` — now lists **sessions that have at least one capture**,
  newest activity first. A row:
  `{ sessionId, firstSeenAt, lastSeenAt, reasonTypes: string[], url, tags, eventCount, captureCount }`.
  Filters (`range`, `reasonType`, `tag`) select sessions by their captures.
  Keyset pagination on `(lastSeenAt, sessionId)`.
- `GET …/timelines/:sessionId` — the session detail:
  `{ session: { sessionId, firstSeenAt, lastSeenAt, events, url, tags }, captures: [...] }`.
  `:sessionId` replaces `:timelineId`.
- `GET …/timelines/summary` — unchanged shape; counts **captures** by reason type
  (a session with two errors counts twice), so the volume chart keeps meaning.
- `GET …/timelines/tags` — unchanged; tag counts come from captures.

### Migration

One drizzle migration:

1. Create `timeline_sessions` and `captures`.
2. For each `timelines` row, in `received_at, id` order: upsert the session and
   merge its `events` (stamped `source: "browser"`, id derived from content)
   into `timeline_sessions.events`, deduping across rows of the same session; insert a
   `captures` row from the reason/meta/tags.
3. Drop `timelines` (and its indexes).

## Dashboard

- **List** becomes a session list: last activity (relative), reason-type chips,
  URL path, tags, event count, capture count. A row links to the session detail.
- **Detail** shows the session's full timeline (oldest first) as one vertical
  stream. Each event carries a small **source chip**, color-coded:
  `--color-source-browser` / `--color-source-server`, unknown sources neutral.
  Capture markers (reason, type, time) are interleaved at their `occurred_at`
  and highlighted.
- **Filters** work the same, now selecting sessions.
- **Charts** unchanged, counting captures.
- Client-supplied strings stay rendered as text; `meta.url` links only for
  `http:`/`https:` (unchanged rule).

New color tokens in `dashboard/src/index.css`, following the existing `@theme`
and `prefers-color-scheme` pattern, checked with the dataviz validator against
the dashboard surfaces.

## Testing

**`server`** (`npm test -w server`, testcontainers Postgres)

- Stage: `POST /v1/events` upserts and appends to `pending_events`; nothing is
  visible; default `source` is `server`; bad event shape is `400`.
- Bake: `POST /v1/timeline` merges staged + payload events, dedupes by id and by
  content hash, sorts by timestamp, caps at `MAX_SESSION_EVENTS`, records the
  capture, and clears `pending_events`. Two captures in one session do not
  duplicate events.
- Concurrency: two captures racing a bake don't lose a staged event (row lock).
- Auth: `Authorization: Bearer` and `X-Tripcord-Key` both work; neither is 401.
- Pruning: a session idle past `STAGING_TTL` is deleted; a recently updated one
  survives; `captures` are untouched by the staging sweep.
- Read API: session list filters and pagination; session detail merges events and
  lists captures; summary counts captures; a session in another project/org is
  `404`; isolation `CASES` covers each route.
- Migration: old `timelines` rows become one session per `session_id` with
  deduped events and one capture per row; `timelines` is gone.

**`packages/js`**

- `createTracer` stamps `id` and the configured `source` on every event.
- Browser adapter sets `source: "browser"`; existing tests still pass.
- `@tripcord/js/node`: `track()` posts to `/v1/events` with `source: "server"`;
  `capture()` posts a capture and, with `stageEvents: false`, includes the local
  buffer; `getSessionId()`/`getEvents()` return what was tracked; `flush()`
  resolves after in-flight sends; failure warns and never throws.
- Package `exports` includes `./node`; the built entry has no browser globals.

**`dashboard`**

- Session list renders reason chips, counts and tags; filters round-trip in the
  URL.
- Detail: events ordered, source chips present, capture markers interleaved and
  highlighted; a `javascript:` URL is not a link.

## Docs

- `packages/js/README.md`: `@tripcord/js/node`, `source`/`id`, staging vs
  capturing, `stageEvents`, the seed fallback, and the `Bearer` header.
- `server/README.md`: `/v1/events`, `/v1/sessions`, capture-bakes, `STAGING_TTL`,
  `Bearer` auth; note `POST /v1/timeline` now bakes.
- `README.md` status: remove "server-side (SSR) tracing" from the not-yet list;
  add the session model.
- Supersede notes (not rewrites) added to
  `2026-09-22-repro-ingest-api-design.md` and
  `2026-09-22-repro-client-library-design.md`.
- Version bumps: server `0.4.0`, `@tripcord/js` `0.3.0`.

## Explicitly out of scope

- A Redis (or any non-Postgres) staging store.
- A browser→server flush handshake / `/.tripcord/flush` endpoint.
- Cross-session event queries or an `events` row table (events stay on the
  session jsonb).
- Grouping captures into "issues", message normalization, text search.
- Saved views, dark/light token work beyond the two new source colors.
- A standalone `@tripcord/node` package (subpath only).
- Retention of baked sessions independent of the staging sweep.
