# repro Dashboard (4b): Timeline Viewer & Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let developers tag timelines by app area in `@repro/js`, store the tags at ingest, and read timelines in the dashboard: a filterable list, a volume chart (bars or lines), a top-reasons table, and a detail page with links to other timelines from the same session.

**Architecture:** The work runs through all three workspaces, in the order the data flows.
- **Client (`packages/js`):** a pure `normalizeTags` rule in `core/`, scope tags held by the core tracer, and `setTags` / `clearTags` / `capture(…, { tags })` on the public API and the React `ErrorBoundary`.
- **Server:** a `timelines.tags` column plus two indexes, an ingest schema that accepts `tags`, a read service (`server/src/db/timelines.ts`) that builds every query from one set of filter conditions, and four `GET` routes behind the 4a membership hooks.
- **Dashboard:** the project page splits into Timelines and Keys tabs. Filters live in the URL. Charts are hand-rolled SVG: one `ChartFrame` and two mark layers, colored from CSS tokens.

**Tech Stack:** TypeScript, tsup, Fastify 5, Drizzle ORM 0.36 + drizzle-kit 0.28, Postgres (`text[]`, GIN, `generate_series`), Vitest 2 + testcontainers, React 18, React Router 7, TanStack Query 5 (`useInfiniteQuery`), Tailwind CSS 4, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-23-repro-dashboard-timelines-design.md`

## Global Constraints

- **Tag rule:** after trimming and lowercasing, a tag matches `^[a-z0-9][a-z0-9_.:-]{0,49}$`. A timeline carries at most 10 tags, with no duplicates. The rule is written out twice, once in `packages/js/src/core/tags.ts` and once in `server/src/tags.ts`, and each copy has a comment pointing at the other. The server doesn't import it from `@repro/js` at runtime, because its Docker image only carries the client's types.
- **The client never throws over tags.** It drops invalid tags and cuts anything past 10, with a `console.warn` each time, and omits the `tags` field when the result is empty.
- **The server stays strict.** The ingest schema rejects an invalid tag, a duplicate, or more than 10 tags with `400`. Tags are stored as `text[] NOT NULL DEFAULT '{}'`.
- **`received_at` holds UTC wall-clock time.** It's a `timestamp` written by `now()` on a UTC Postgres, the same assumption drizzle and the retention job already make. Queries compare it with `now() AT TIME ZONE 'UTC'` and never with `localtimestamp`. Timestamps are returned as `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, which keeps all six fractional digits.
- **The list cursor is `base64url("<receivedAt ISO with µs>|<id>")`.** It's compared as `(received_at, id) < ($ts::timestamp, $id::uuid)`, and never passes through a JS `Date`. Postgres ignores the trailing `Z` when it casts to `timestamp`.
- **Top-reasons key:** `md5(jsonb_build_array(reason_type, reason->>'name', reason->>'message')::text)`. It's built only from expressions that also appear in `GROUP BY`, and with no bound parameters inside them, so Postgres can match them.
- **Every `/api/orgs/:orgId/projects/:projectId/timelines…` route** uses `preValidation: [requireUser, requireMembership("member")]`, then checks the project in the org, then looks the timeline up together with its `project_id`. A timeline in another project, a project in another org, or a malformed id is `404 { error: "Not Found" }`.
- **Query validation:** every querystring schema has `additionalProperties: false`. Fastify's default Ajv coerces a single repeated param (`?tag=a`) into an array (`coerceTypes: "array"`), so `reasonType` and `tag` are declared as arrays.
- **`tz`** is valid only if `new Intl.DateTimeFormat("en-US", { timeZone })` accepts it *and* it matches `^[A-Za-z0-9_+\-/]{1,64}$`. Otherwise the response is `400 { error: "Invalid time zone" }`.
- **Chart colors are CSS variables only:** `--color-series-error`, `--color-series-rejection`, `--color-series-manual`. Their light and dark values come from the spec. A series always keeps its color, whichever series are filtered out. Text uses `--color-fg` / `--color-muted`, never a series color.
- **No new runtime dependency** in any workspace. That includes charts, which are hand-rolled SVG.
- **Client-supplied strings are always rendered as React text.** `meta.url` becomes a link only when its protocol is `http:` or `https:`. No `dangerouslySetInnerHTML`.
- **Existing test conventions apply.** Server test files run serially on one testcontainers Postgres, and each resets the database in `beforeEach`. Dashboard tests go through `renderApp` + `mockApi`.
- **`@repro/js` becomes `0.2.0`.** `server/package.json` must then depend on `^0.2.0`. A `^0.1.0` range doesn't match 0.2.0, and npm would try the registry.

## Review Focus

These are the parts most likely to be wrong while tests still pass. Each one has a test pinned to it in the task named.

1. **Microsecond cursor.** Three rows share a millisecond and differ only in microseconds. Paging with `limit=1` returns all three exactly once, newest first. (Task 3)
2. **The top-reasons key round-trips.** Feeding a `topReasons[].key` back as `reason=` lists exactly that group's timelines. That includes a group whose `name` is absent, where the JSON array holds a null. (Task 3)
3. **Non-UTC buckets.** With `tz=Asia/Kolkata` (+05:30, no DST), every daily bucket starts at `18:30:00.000Z`, and each row falls inside its bucket. (Task 3)
4. **Scope tags on auto-captured errors.** `setTags(["video_player"])` followed by a `window` `error` event sends `tags: ["video_player"]`, because most timelines are captured this way. (Task 1)
5. **A `javascript:` URL is never a link** on the detail page. (Task 8)

## Prerequisites

From the repo root, once: `npm install`. Docker must be running for the server tests.

Commands: `npm test -w packages/js`, `npm test -w server` (a single file: `npm test -w server -- src/db/timelines.test.ts`), `npm test -w dashboard`. Whole repo: `npm run build && npm run typecheck && npm run lint && npm test`.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `packages/js/src/core/tags.ts` | create | `TAG_PATTERN`, `MAX_TAGS`, `normalizeTags` |
| `packages/js/src/core/types.ts` | modify | `TimelinePayload.tags?`, `CaptureOptions` |
| `packages/js/src/core/payload.ts` | modify | `buildPayload(…, tags)` omits empty tags |
| `packages/js/src/core/tracer.ts` | modify | scope tags, `setTags`, `clearTags`, `capture` options |
| `packages/js/src/browser/createTracer.ts` | modify | expose `setTags` / `clearTags`; no-op tracer gains them |
| `packages/js/src/index.ts` | modify | module-level `setTags` / `clearTags`; `capture` options; export `CaptureOptions` |
| `packages/js/src/react/ErrorBoundary.tsx` | modify | `tags` prop |
| `packages/js/README.md`, `packages/js/package.json` | modify | Tags section; version `0.2.0` |
| `server/package.json`, `package-lock.json` | modify | `@repro/js` `^0.2.0` |
| `server/src/tags.ts` | create | server copy of the tag rule; `tagSchema` |
| `server/src/db/schema.ts` | modify | `timelines.tags`, GIN index, `(project_id, session_id)` index |
| `server/drizzle/0003_*.sql` + `meta/*` | generate | migration |
| `server/src/routes/timeline.ts` | modify | ingest accepts and stores `tags` |
| `server/test/db.ts` | modify | `insertTestTimeline`, `pgTimestampAgo` |
| `server/src/db/timelines.ts` | create | read service: filters, cursor, list, summary, tags, detail |
| `server/src/routes/projects.ts` | modify | export `requireProject` |
| `server/src/routes/timelines.ts` | create | the four read routes |
| `server/src/app.ts` | modify | register the read routes |
| `server/src/routes/isolation.test.ts` | modify | four new cases; fixture `timelineId` |
| `dashboard/src/index.css` | modify | series color tokens |
| `dashboard/src/types.ts` | modify | timeline response types |
| `dashboard/src/timelineFilters.ts` | create | URL ⇄ filters; `useTimelineFilters` |
| `dashboard/src/queries.ts` | modify | `useTimelines`, `useTimelineSummary`, `useTimelineTags`, `useTimeline` |
| `dashboard/src/format.ts` | modify | `formatDateTime`, `formatRelative`, `formatOffset`, `urlPath`, `safeHref`, `REASON_LABELS` |
| `dashboard/src/components/ui.tsx` | modify | `Segmented`, `CopyButton`, `Chip`, `Swatch` |
| `dashboard/src/components/OnceSecret.tsx` | modify | use `CopyButton` |
| `dashboard/src/pages/ProjectLayout.tsx` | create | project header, Timelines / Keys tabs, not-found |
| `dashboard/src/pages/ProjectKeysPage.tsx` | create | 4a key management, moved from `ProjectPage.tsx` |
| `dashboard/src/pages/ProjectPage.tsx` | delete | replaced by the two files above |
| `dashboard/src/components/charts/*` | create | `scale.ts`, `series.ts`, `ChartFrame.tsx`, `StackedBars.tsx`, `Lines.tsx`, `VolumeChart.tsx` |
| `dashboard/src/components/timelines/*` | create | `FilterBar.tsx`, `TagPicker.tsx`, `TopReasons.tsx`, `TimelineList.tsx`, `EmptyState.tsx`, `TagChips.tsx` |
| `dashboard/src/pages/TimelinesPage.tsx` | create | the Timelines tab |
| `dashboard/src/pages/TimelinePage.tsx` | create | timeline detail |
| `dashboard/src/App.tsx` | modify | routes |
| `dashboard/src/test/utils.tsx` | modify | `mockApi` falls back to matching the path without its query |

---

### Task 1: Tags in `@repro/js`

**Files:**
- Create: `packages/js/src/core/tags.ts`, `packages/js/src/core/tags.test.ts`
- Modify: `packages/js/src/core/types.ts`, `packages/js/src/core/payload.ts`, `packages/js/src/core/tracer.ts`, `packages/js/src/core/tracer.test.ts`, `packages/js/src/browser/createTracer.ts`, `packages/js/src/browser/createTracer.test.ts`, `packages/js/src/browser/createTracer.node.test.ts`, `packages/js/src/index.ts`, `packages/js/src/index.test.ts`, `packages/js/src/react/ErrorBoundary.tsx`, `packages/js/src/react/ErrorBoundary.test.tsx`, `packages/js/src/dist-smoke.test.ts`

- [ ] **Step 1: Write the failing tag-rule tests**

Create `packages/js/src/core/tags.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { MAX_TAGS, normalizeTags } from "./tags";

describe("normalizeTags", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("trims, lowercases and de-duplicates, keeping first-seen order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTags([" Checkout ", "video_player", "checkout"])).toEqual(["checkout", "video_player"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts the documented punctuation", () => {
    expect(normalizeTags(["a:b", "v1.2", "a-b_c", "9lives"])).toEqual(["a:b", "v1.2", "a-b_c", "9lives"]);
  });

  it("drops invalid tags with one warning each", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTags(["ok", "has space", "", "-lead", "x".repeat(51), 42])).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it(`keeps the first ${MAX_TAGS} tags and warns once`, () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tags = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(normalizeTags(tags)).toEqual(tags.slice(0, MAX_TAGS));
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns [] with a warning for a non-array", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeTags("checkout")).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/js -- src/core/tags.test.ts`
Expected: FAIL. `./tags` doesn't exist.

- [ ] **Step 3: Implement the tag rule**

Create `packages/js/src/core/tags.ts`:

```ts
// The tag rule. The server's ingest schema has its own copy (server/src/tags.ts)
// and the two must match: a tag the client sends but the server rejects loses the
// whole timeline, because the transport never reads the response.
export const TAG_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,49}$/;
export const MAX_TAGS = 10;

/**
 * Trims, lowercases and de-duplicates tags, keeping first-seen order. Invalid
 * tags are dropped and anything past MAX_TAGS is cut, each with a console
 * warning. Never throws.
 */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) {
    console.warn("[repro] tags must be an array of strings.");
    return [];
  }
  const result: string[] = [];
  for (const raw of tags) {
    const tag = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!TAG_PATTERN.test(tag)) {
      console.warn(`[repro] dropping invalid tag ${JSON.stringify(raw)}: tags must match ${TAG_PATTERN}.`);
      continue;
    }
    if (!result.includes(tag)) {
      result.push(tag);
    }
  }
  if (result.length > MAX_TAGS) {
    console.warn(`[repro] a timeline carries at most ${MAX_TAGS} tags; keeping the first ${MAX_TAGS}.`);
    return result.slice(0, MAX_TAGS);
  }
  return result;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -w packages/js -- src/core/tags.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing tracer tests**

Append inside the `describe("createTracer", …)` block of `packages/js/src/core/tracer.test.ts`:

```ts
  it("capture() sends scope tags ∪ capture tags", () => {
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.capture("payment-declined", undefined, { tags: ["payments", "checkout"] });
    expect(send.mock.calls[0][0].tags).toEqual(["checkout", "payments"]);
  });

  it("auto-captured errors and rejections carry the scope tags", () => {
    const { send, tracer } = setup();
    tracer.setTags(["video_player"]);
    tracer.captureError("boom");
    tracer.captureUnhandledRejection("nope");
    expect(send.mock.calls.map((call) => call[0].tags)).toEqual([["video_player"], ["video_player"]]);
  });

  it("setTags() replaces the scope rather than adding to it", () => {
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.setTags(["shopping_cart"]);
    tracer.captureError("boom");
    expect(send.mock.calls[0][0].tags).toEqual(["shopping_cart"]);
  });

  it("ignores capture tags that aren't an array, with a warning, instead of splitting a string", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.capture("x", undefined, { tags: "payments" as unknown as string[] });
    expect(send.mock.calls[0][0].tags).toEqual(["checkout"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("clearTags() empties the scope, and an untagged payload has no tags field", () => {
    const { send, tracer } = setup();
    tracer.setTags(["checkout"]);
    tracer.clearTags();
    tracer.capture("payment-declined");
    expect(send.mock.calls[0][0]).not.toHaveProperty("tags");
  });
```

- [ ] **Step 6: Run to verify they fail**

Run: `npm test -w packages/js -- src/core/tracer.test.ts`
Expected: FAIL. `tracer.setTags is not a function`.

- [ ] **Step 7: Implement tags in core**

In `packages/js/src/core/types.ts`, add `tags` to `TimelinePayload` and add `CaptureOptions`:

```ts
export interface TimelinePayload {
  sessionId: string;
  reason: TimelineReason;
  events: TimelineEvent[];
  meta: TimelineMeta;
  /** Where the error happened; omitted when there are none. */
  tags?: string[];
}

export interface CaptureOptions {
  /** Added to the tracer's scope tags for this capture only. */
  tags?: string[];
}
```

Replace `packages/js/src/core/payload.ts`:

```ts
import type { TimelineEvent, TimelineReason, TimelineMeta, TimelinePayload } from "./types";

export function buildPayload(
  sessionId: string,
  reason: TimelineReason,
  events: TimelineEvent[],
  meta: Omit<TimelineMeta, "capturedAt">,
  tags: string[] = []
): TimelinePayload {
  return {
    sessionId,
    reason,
    events,
    meta: { ...meta, capturedAt: Date.now() },
    // Omitted when empty, so an untagged client works against a server that
    // predates tags (its schema rejects unknown fields).
    ...(tags.length > 0 ? { tags } : {}),
  };
}
```

Replace `packages/js/src/core/tracer.ts`:

```ts
import { createBuffer } from "./buffer";
import { buildPayload } from "./payload";
import { warnOnRiskyKeys } from "./guardrails";
import { normalizeTags } from "./tags";
import type { CaptureOptions, TimelineEvent, TimelinePayload, TimelineMeta } from "./types";

export interface TracerConfig {
  sessionId: string;
  maxEvents?: number;
  seedEvents?: TimelineEvent[];
  send: (payload: TimelinePayload) => void;
  getMeta: () => Omit<TimelineMeta, "capturedAt">;
  onBufferChange?: (events: TimelineEvent[]) => void;
}

export interface Tracer {
  track(name: string, data?: Record<string, unknown>): void;
  capture(name?: string, data?: Record<string, unknown>, options?: CaptureOptions): void;
  captureError(message: string): void;
  captureUnhandledRejection(message: string): void;
  traceElement(label: string): void;
  setTags(tags: string[]): void;
  clearTags(): void;
}

export function createTracer(config: TracerConfig): Tracer {
  const buffer = createBuffer(config.maxEvents ?? 50, config.seedEvents ?? []);
  // In memory only: the app sets them again after a reload.
  let scopeTags: string[] = [];

  function pushEvent(event: TimelineEvent): void {
    buffer.push(event);
    config.onBufferChange?.(buffer.getAll());
  }

  function flush(reason: TimelinePayload["reason"], captureTags?: unknown): void {
    // Capture tags are normalized on their own first: spreading a caller's raw
    // value would split a string like "checkout" into one-letter tags.
    const extra = captureTags === undefined ? [] : normalizeTags(captureTags);
    const tags = normalizeTags([...scopeTags, ...extra]);
    const payload = buildPayload(config.sessionId, reason, buffer.getAll(), config.getMeta(), tags);
    config.send(payload);
  }

  return {
    track(name, data) {
      warnOnRiskyKeys(data);
      pushEvent({ timestamp: Date.now(), type: "custom", name, data });
    },
    capture(name, data, options) {
      warnOnRiskyKeys(data);
      flush({ type: "manual", name, data }, options?.tags);
    },
    captureError(message) {
      flush({ type: "error", message });
    },
    captureUnhandledRejection(message) {
      flush({ type: "unhandledrejection", message });
    },
    traceElement(label) {
      pushEvent({ timestamp: Date.now(), type: "trace", name: label });
    },
    setTags(tags) {
      scopeTags = normalizeTags(tags);
    },
    clearTags() {
      scopeTags = [];
    },
  };
}
```

- [ ] **Step 8: Run the core tests**

Run: `npm test -w packages/js -- src/core`
Expected: PASS, including the existing `payload.test.ts`, because untagged payloads are unchanged.

- [ ] **Step 9: Write the failing browser and entry-point tests**

Append to the `describe("browser createTracer", …)` block in `packages/js/src/browser/createTracer.test.ts`:

```ts
  it("sends scope tags with an auto-captured window error", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const tracer = trackedCreateTracer({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    tracer.setTags(["video_player"]);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tags).toEqual(["video_player"]);
  });
```

In `packages/js/src/browser/createTracer.node.test.ts`, add these two lines to the no-op test, before `expect(() => tracer.dispose()).not.toThrow();`:

```ts
    expect(() => tracer.setTags(["checkout"])).not.toThrow();
    expect(() => tracer.clearTags()).not.toThrow();
```

In `packages/js/src/index.test.ts`:

1. Add the new mocks next to the existing ones, and include them in `createTracerMock`'s return value:

```ts
const setTagsMock = vi.fn();
const clearTagsMock = vi.fn();
const createTracerMock = vi.fn(() => ({
  track: trackMock,
  capture: captureMock,
  setTags: setTagsMock,
  clearTags: clearTagsMock,
  dispose: disposeMock,
}));
```

2. The module-level `capture` now forwards a third argument, so change the existing assertion `expect(captureMock).toHaveBeenCalledWith("payment-declined", undefined);` to:

```ts
    expect(captureMock).toHaveBeenCalledWith("payment-declined", undefined, undefined);
```

3. Append:

```ts
  it("warns and no-ops if setTags()/clearTags() are called before init()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setTags, clearTags } = await import("./index");

    setTags(["checkout"]);
    clearTags();

    expect(setTagsMock).not.toHaveBeenCalled();
    expect(clearTagsMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("delegates setTags()/clearTags() and capture options after init()", async () => {
    const { init, setTags, clearTags, capture } = await import("./index");

    init({ endpoint: "https://ingest.example.com/timeline", apiKey: "key-123" });
    setTags(["checkout"]);
    capture("payment-declined", { code: "x" }, { tags: ["payments"] });
    clearTags();

    expect(setTagsMock).toHaveBeenCalledWith(["checkout"]);
    expect(captureMock).toHaveBeenCalledWith("payment-declined", { code: "x" }, { tags: ["payments"] });
    expect(clearTagsMock).toHaveBeenCalledOnce();
  });
```

Append to `packages/js/src/react/ErrorBoundary.test.tsx`, inside its `describe`:

```ts
  it("passes its tags prop to capture()", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary tags={["checkout"]} fallback={<p>something broke</p>}>
        <Boom />
      </ErrorBoundary>
    );

    expect(captureMock.mock.calls[0][2]).toEqual({ tags: ["checkout"] });
    consoleError.mockRestore();
  });
```

In `packages/js/src/dist-smoke.test.ts`, add to the first test:

```ts
    expect(typeof pkg.setTags).toBe("function");
    expect(typeof pkg.clearTags).toBe("function");
```

- [ ] **Step 10: Run to verify they fail**

Run: `npm test -w packages/js`
Expected: FAIL. `setTags` isn't exported, `tracer.setTags` isn't a function in the browser tracer, and the `ErrorBoundary` `tags` assertion fails.

- [ ] **Step 11: Implement the browser, entry-point and React changes**

In `packages/js/src/browser/createTracer.ts`:

1. Change the imports and the `BrowserTracer` interface:

```ts
import type { CaptureOptions, TimelineEvent } from "../core/types";
```

```ts
export interface BrowserTracer {
  track(name: string, data?: Record<string, unknown>): void;
  capture(name?: string, data?: Record<string, unknown>, options?: CaptureOptions): void;
  setTags(tags: string[]): void;
  clearTags(): void;
  dispose(): void;
}
```

2. Change the no-op return to:

```ts
    return { track() {}, capture() {}, setTags() {}, clearTags() {}, dispose() {} };
```

3. Change the final return to:

```ts
  return {
    track: core.track,
    capture: core.capture,
    setTags: core.setTags,
    clearTags: core.clearTags,
    dispose() {
      disposers.forEach((dispose) => dispose());
    },
  };
```

In `packages/js/src/index.ts`, change the type export line and `capture`, and append `setTags` / `clearTags`:

```ts
export type { TimelineEvent, TimelinePayload, TimelineReason, TimelineMeta, CaptureOptions } from "./core/types";
```

```ts
export function capture(name?: string, data?: Record<string, unknown>, options?: CaptureOptions): void {
  if (!defaultTracer) {
    console.warn("[repro] capture() called before init().");
    return;
  }
  defaultTracer.capture(name, data, options);
}

/** Replaces the tags every following timeline carries, until changed or cleared. */
export function setTags(tags: string[]): void {
  if (!defaultTracer) {
    console.warn("[repro] setTags() called before init().");
    return;
  }
  defaultTracer.setTags(tags);
}

export function clearTags(): void {
  if (!defaultTracer) {
    console.warn("[repro] clearTags() called before init().");
    return;
  }
  defaultTracer.clearTags();
}
```

Add the type import at the top of `index.ts`:

```ts
import type { CaptureOptions } from "./core/types";
```

In `packages/js/src/react/ErrorBoundary.tsx`, add the prop and pass it on:

```tsx
export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  /** Tags for errors caught by this boundary, on top of the scope tags. */
  tags?: string[];
}
```

```tsx
  componentDidCatch(error: Error, info: ErrorInfo): void {
    capture(error.message, { componentStack: info.componentStack }, { tags: this.props.tags });
  }
```

With no `tags` prop this passes `{ tags: undefined }`, and the core tracer treats an undefined `tags` as "no capture tags", with no warning.

- [ ] **Step 12: Run the package's checks**

Run: `npm test -w packages/js && npm run typecheck -w packages/js && npm run lint -w packages/js`
Expected: all PASS. `pretest` rebuilds `dist/`, so `dist-smoke.test.ts` sees the new exports. The lint boundary rule still passes, because `core/tags.ts` imports nothing.

- [ ] **Step 13: Bump the version and the server's range**

In `packages/js/package.json` set `"version": "0.2.0"`. In `server/package.json` change `"@repro/js": "^0.1.0"` to `"@repro/js": "^0.2.0"`. Then from the repo root:

```bash
npm install
```

Expected: `package-lock.json` updates the workspace link to 0.2.0, with no registry fetch for `@repro/js`. Check with `npm ls @repro/js`: it should show `@repro/js@0.2.0 -> ./packages/js` under `@repro/server`.

- [ ] **Step 14: Document tags in the client README**

In `packages/js/README.md`, add this section after the React error boundary example in "## Quick start":

````markdown
### Tags

Tags say where in your app a timeline came from, so you can filter by area in the
dashboard. Set the active area once, and every timeline captured after that
carries it. That includes uncaught errors, which have no call site of their own:

```ts
import { setTags, clearTags, capture } from "@repro/js";

setTags(["checkout"]);          // e.g. when the checkout route mounts
capture("payment-declined", { code }, { tags: ["payments"] }); // adds to the scope
clearTags();                    // leaving the area
```

`<ErrorBoundary tags={["video_player"]}>` tags what that boundary catches.

Tags are trimmed and lowercased, and must match `^[a-z0-9][a-z0-9_.:-]{0,49}$`.
A timeline carries up to 10 of them. Invalid tags are dropped with a console
warning, never thrown.

**Upgrade the ingest server before you ship a client that sets tags.** An older
server rejects any payload with a `tags` field. A client that never sets tags
doesn't send the field and works with any server.
````

- [ ] **Step 15: Commit**

```bash
git add packages/js server/package.json package-lock.json
git commit -m "feat(js): scoped and per-capture tags; 0.2.0"
```

---

### Task 2: Store tags at ingest

**Files:**
- Create: `server/src/tags.ts`, `server/drizzle/0003_*.sql` (generated), `server/drizzle/meta/0003_snapshot.json` (generated)
- Modify: `server/src/db/schema.ts`, `server/drizzle/meta/_journal.json` (generated), `server/src/routes/timeline.ts`, `server/src/routes/timeline.test.ts`, `server/src/db/migrations.test.ts`, `server/test/db.ts`

- [ ] **Step 1: Write the failing ingest tests**

Append to the first `describe("POST /v1/timeline", …)` block in `server/src/routes/timeline.test.ts`:

```ts
  it("stores tags, and {} when the payload has none", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    for (const payload of [{ ...validPayload, tags: ["checkout", "payments"] }, validPayload]) {
      const response = await app.inject({ method: "POST", url: "/v1/timeline", headers: { "x-repro-key": key }, payload });
      expect(response.statusCode).toBe(201);
    }

    const rows = await db.select({ tags: timelines.tags }).from(timelines);
    expect(rows.map((row) => row.tags).sort((a, b) => b.length - a.length)).toEqual([["checkout", "payments"], []]);
  });

  it.each([
    ["an uppercase tag", ["Checkout"]],
    ["a tag with a space", ["check out"]],
    ["a 51-character tag", ["x".repeat(51)]],
    ["a duplicate", ["checkout", "checkout"]],
    ["11 tags", Array.from({ length: 11 }, (_, i) => `t${i}`)],
  ])("returns 400 and stores nothing for %s", async (_label, tags) => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": key },
      payload: { ...validPayload, tags },
    });

    expect(response.statusCode).toBe(400);
    expect(await db.select().from(timelines)).toHaveLength(0);
  });
```

These cases deliberately leave out non-string items and a bare string. Fastify's default Ajv has `coerceTypes: "array"`, which turns `"checkout"` into `["checkout"]` and `42` into `"42"`, and both are valid. The client never sends either.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w server -- src/routes/timeline.test.ts`
Expected: the storing test FAILS, because `timelines.tags` is undefined. The five 400 cases already pass, since today any `tags` field is rejected as an unknown property. They stay as regression tests once `tags` is allowed.

- [ ] **Step 3: Add the server's tag rule**

Create `server/src/tags.ts`:

```ts
// Must match TAG_PATTERN and MAX_TAGS in packages/js/src/core/tags.ts. The
// client normalizes tags to this rule before sending, so a real client never
// hits the 400 that this schema produces.
export const TAG_PATTERN_SOURCE = "^[a-z0-9][a-z0-9_.:-]{0,49}$";
export const MAX_TAGS = 10;

export const tagSchema = { type: "string", pattern: TAG_PATTERN_SOURCE } as const;
```

- [ ] **Step 4: Add the column and indexes**

In `server/src/db/schema.ts`, add `sql` to the imports:

```ts
import { sql } from "drizzle-orm";
```

Replace the `timelines` table:

```ts
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
    // Where the error happened, set by the client (see server/src/tags.ts).
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => ({
    projectReceivedIdx: index("timelines_project_received_idx").on(table.projectId, table.receivedAt),
    projectReasonTypeIdx: index("timelines_project_reason_type_idx").on(table.projectId, table.reasonType),
    projectSessionIdx: index("timelines_project_session_idx").on(table.projectId, table.sessionId),
    tagsIdx: index("timelines_tags_idx").using("gin", table.tags),
  })
);
```

- [ ] **Step 5: Generate the migration**

Run: `cd server && npx drizzle-kit generate`
Expected: a new `server/drizzle/0003_<name>.sql`, plus `meta/0003_snapshot.json` and a journal entry with `idx: 3`. The SQL should be equivalent to:

```sql
ALTER TABLE "timelines" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timelines_project_session_idx" ON "timelines" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timelines_tags_idx" ON "timelines" USING gin ("tags");
```

Don't hand-edit it. If drizzle-kit emits something materially different, such as a table rewrite or a missing index, stop and report it rather than patching the SQL.

- [ ] **Step 6: Accept and store tags at ingest**

In `server/src/routes/timeline.ts`, import the rule:

```ts
import { MAX_TAGS, tagSchema } from "../tags";
```

Add `tags` to `timelinePayloadSchema.properties`:

```ts
    tags: { type: "array", maxItems: MAX_TAGS, uniqueItems: true, items: tagSchema },
```

In the handler's `.values({…})`, add:

```ts
          tags: request.body.tags ?? [],
```

`request.body` is typed as `@repro/js`'s `TimelinePayload`, which now has `tags?: string[]`, because Task 1 rebuilt the package.

- [ ] **Step 7: Write the migration test**

In `server/src/db/migrations.test.ts`, generalize the journal helper so a test can stop before any migration. Replace `migrationsBeforeOrgs` with:

```ts
// A copy of the migrations folder whose journal stops before migration `idx`.
function migrationsBefore(idx: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repro-migrations-"));
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx < idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}
```

Change the existing callers from `migrationsBeforeOrgs()` to `migrationsBefore(2)`, then append:

```ts
describe("tags migration (0003)", () => {
  it("gives existing timelines an empty tags array", async () => {
    await withFreshDatabase(async (pool) => {
      const db = drizzle(pool);
      const before = migrationsBefore(3);
      try {
        await migrate(db, { migrationsFolder: before });
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      const org = await pool.query<{ id: string }>(`INSERT INTO orgs (name) VALUES ('o') RETURNING id`);
      const project = await pool.query<{ id: string }>(
        `INSERT INTO projects (org_id, name) VALUES ($1, 'p') RETURNING id`,
        [org.rows[0].id]
      );
      await pool.query(
        `INSERT INTO timelines (project_id, session_id, reason_type, reason, events, meta)
         VALUES ($1, 's', 'manual', '{"type":"manual"}', '[]', '{"url":"u","userAgent":"a","capturedAt":1}')`,
        [project.rows[0].id]
      );

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const rows = await pool.query<{ tags: string[] }>(`SELECT tags FROM timelines`);
      expect(rows.rows).toEqual([{ tags: [] }]);
    });
  });
});
```

- [ ] **Step 8: Add the timeline test helpers**

The read tasks need rows with chosen times and tags. In `server/test/db.ts`, add `sql` to the imports (`import { sql } from "drizzle-orm";`) and append:

```ts
export interface TestTimelineOptions {
  sessionId?: string;
  reason?: { type: "error" | "unhandledrejection" | "manual"; name?: string; message?: string };
  tags?: string[];
  events?: unknown[];
  url?: string;
  /** UTC timestamp text as Postgres prints `timestamp`, e.g. from pgTimestampAgo(). Default: now. */
  receivedAt?: string;
}

/** Inserts a timeline directly (bypassing ingest) and returns its id. */
export async function insertTestTimeline(db: Database, projectId: string, options: TestTimelineOptions = {}): Promise<string> {
  const reason = options.reason ?? { type: "error", name: "TypeError", message: "boom" };
  const [row] = await db
    .insert(timelines)
    .values({
      projectId,
      sessionId: options.sessionId ?? "session-1",
      reasonType: reason.type,
      reason,
      events: options.events ?? [{ timestamp: 1, type: "custom", name: "step" }],
      meta: { url: options.url ?? "https://shop.example.com/checkout", userAgent: "test-agent", capturedAt: 1 },
      tags: options.tags ?? [],
      ...(options.receivedAt === undefined ? {} : { receivedAt: sql`${options.receivedAt}::timestamp` }),
    })
    .returning({ id: timelines.id });
  return row.id;
}

/** UTC wall-clock text for `ms` milliseconds ago, millisecond precision: "2026-09-23 10:15:02.123". */
export function pgTimestampAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace("T", " ").replace("Z", "");
}
```

- [ ] **Step 9: Run the server checks**

Run: `npm test -w server -- src/routes/timeline.test.ts src/db/migrations.test.ts && npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server
git commit -m "feat(server): store timeline tags at ingest"
```

---

### Task 3: Timeline read service

**Files:**
- Create: `server/src/db/timelines.ts`, `server/src/db/timelines.test.ts`

- [ ] **Step 1: Write the failing service tests**

Create `server/src/db/timelines.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, insertTestTimeline, pgTimestampAgo, resetDb } from "../../test/db";
import {
  decodeCursor,
  encodeCursor,
  getTimeline,
  listTags,
  listTimelines,
  summarizeTimelines,
  type Cursor,
  type Range,
  type TimelineFilters,
} from "./timelines";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ALL: TimelineFilters = { range: "30d", reasonTypes: [], tags: [] };
const PAGE = { limit: 50 };

async function newProject(): Promise<string> {
  return (await createTestProject(getTestDb())).project.id;
}

/** Epoch ms of a pgTimestampAgo() value (UTC wall-clock text). */
function epochOf(pgTimestamp: string): number {
  return Date.parse(`${pgTimestamp.replace(" ", "T")}Z`);
}

describe("timeline read service", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  describe("listTimelines", () => {
    it("lists newest first within the range", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const recent = await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(2 * HOUR) });
      const days = await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(3 * DAY) });
      const old = await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(10 * DAY) });

      const ids = async (range: Range) =>
        (await listTimelines(db, projectId, { ...ALL, range }, PAGE)).timelines.map((t) => t.id);
      expect(await ids("24h")).toEqual([recent]);
      expect(await ids("7d")).toEqual([recent, days]);
      expect(await ids("30d")).toEqual([recent, days, old]);
    });

    it("never returns another project's timelines", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      const mine = await insertTestTimeline(db, projectId);
      await insertTestTimeline(db, otherId);

      const result = await listTimelines(db, projectId, ALL, PAGE);
      expect(result.timelines.map((t) => t.id)).toEqual([mine]);
    });

    it("filters by reason type", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestTimeline(db, projectId, { reason: { type: "error", message: "e" } });
      const manual = await insertTestTimeline(db, projectId, { reason: { type: "manual", name: "m" } });
      const rejection = await insertTestTimeline(db, projectId, { reason: { type: "unhandledrejection", message: "r" } });

      const result = await listTimelines(db, projectId, { ...ALL, reasonTypes: ["manual", "unhandledrejection"] }, PAGE);
      expect(new Set(result.timelines.map((t) => t.id))).toEqual(new Set([manual, rejection]));
    });

    it("matches any of the selected tags", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const checkout = await insertTestTimeline(db, projectId, { tags: ["checkout"] });
      const video = await insertTestTimeline(db, projectId, { tags: ["video_player"] });
      const both = await insertTestTimeline(db, projectId, { tags: ["checkout", "payments"] });
      await insertTestTimeline(db, projectId, { tags: [] });

      const ids = async (tags: string[]) =>
        new Set((await listTimelines(db, projectId, { ...ALL, tags }, PAGE)).timelines.map((t) => t.id));
      expect(await ids(["checkout", "payments"])).toEqual(new Set([checkout, both]));
      expect(await ids(["video_player", "payments"])).toEqual(new Set([video, both]));
    });

    it("returns the list fields: µs ISO time, a 300-character message, the url and the event count", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const id = await insertTestTimeline(db, projectId, {
        reason: { type: "error", name: "TypeError", message: "m".repeat(500) },
        events: [{ timestamp: 1, type: "custom", name: "a" }, { timestamp: 2, type: "custom", name: "b" }, { timestamp: 3, type: "trace", name: "c" }],
        tags: ["checkout"],
        url: "https://shop.example.com/cart?step=2",
      });

      const [row] = (await listTimelines(db, projectId, ALL, PAGE)).timelines;
      expect(row).toEqual({
        id,
        receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
        sessionId: "session-1",
        reasonType: "error",
        reasonName: "TypeError",
        reasonMessage: "m".repeat(300),
        url: "https://shop.example.com/cart?step=2",
        tags: ["checkout"],
        eventCount: 3,
      });
    });

    it("pages through rows that differ only in microseconds, each exactly once", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const base = pgTimestampAgo(HOUR); // millisecond precision: "…:02.123"
      const inserted: string[] = [];
      for (const micros of ["456", "457", "458"]) {
        inserted.push(await insertTestTimeline(db, projectId, { receivedAt: `${base}${micros}` }));
      }

      const seen: string[] = [];
      let cursor: Cursor | undefined;
      for (let i = 0; i < 4; i++) {
        const result = await listTimelines(db, projectId, ALL, { limit: 1, cursor });
        seen.push(...result.timelines.map((t) => t.id));
        if (!result.nextCursor) break;
        cursor = decodeCursor(result.nextCursor);
      }
      expect(seen).toEqual([...inserted].reverse());
    });
  });

  describe("cursor", () => {
    it("round-trips", () => {
      const cursor = { receivedAt: "2026-09-23T10:15:02.123456Z", id: "3b241101-e2bb-4255-8caf-4136c566a962" };
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it.each([
      "",
      "garbage",
      Buffer.from("2026-09-23T10:15:02.123456Z|not-a-uuid").toString("base64url"),
      Buffer.from("yesterday|3b241101-e2bb-4255-8caf-4136c566a962").toString("base64url"),
      Buffer.from("2026-09-23T10:15:02.123456Z|3b241101-e2bb-4255-8caf-4136c566a962|x").toString("base64url"),
    ])("rejects %j", (value) => {
      expect(decodeCursor(value)).toBeUndefined();
    });
  });

  describe("summarizeTimelines", () => {
    it("fills 25 hourly buckets for 24h and splits counts by reason type", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const anHourAgo = pgTimestampAgo(HOUR);
      await insertTestTimeline(db, projectId, { receivedAt: anHourAgo });
      await insertTestTimeline(db, projectId, { receivedAt: anHourAgo });
      await insertTestTimeline(db, projectId, { receivedAt: anHourAgo, reason: { type: "manual", name: "m" } });
      await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(5 * HOUR), reason: { type: "unhandledrejection" } });

      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "24h" }, "UTC");

      expect(summary.bucket).toBe("hour");
      expect(summary.buckets).toHaveLength(25);
      summary.buckets.forEach((b) => expect(b.start).toMatch(/T\d{2}:00:00\.000Z$/));
      const at = epochOf(anHourAgo);
      const holding = summary.buckets.find((b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + HOUR);
      expect(holding).toMatchObject({ error: 2, manual: 1, unhandledrejection: 0 });
      const total = (key: "error" | "manual" | "unhandledrejection") => summary.buckets.reduce((sum, b) => sum + b[key], 0);
      expect([total("error"), total("manual"), total("unhandledrejection")]).toEqual([2, 1, 1]);
    });

    it("fills 8 daily buckets for 7d", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(3 * DAY) });

      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "7d" }, "UTC");

      expect(summary.bucket).toBe("day");
      expect(summary.buckets).toHaveLength(8);
      summary.buckets.forEach((b) => expect(b.start).toMatch(/T00:00:00\.000Z$/));
      expect(summary.buckets.reduce((sum, b) => sum + b.error, 0)).toBe(1);
    });

    it("cuts days at the viewer's midnight", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const anHourAgo = pgTimestampAgo(HOUR);
      await insertTestTimeline(db, projectId, { receivedAt: anHourAgo });

      // Asia/Kolkata is UTC+05:30 with no DST, so local midnight is always 18:30Z.
      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "7d" }, "Asia/Kolkata");

      summary.buckets.forEach((b) => expect(b.start).toMatch(/T18:30:00\.000Z$/));
      const at = epochOf(anHourAgo);
      const holding = summary.buckets.find((b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + DAY);
      expect(holding?.error).toBe(1);
    });

    it("ranks top reasons by count and truncates their messages", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      for (let i = 0; i < 3; i++) {
        await insertTestTimeline(db, projectId, { reason: { type: "error", name: "TypeError", message: "a" } });
      }
      for (let i = 0; i < 2; i++) {
        await insertTestTimeline(db, projectId, { reason: { type: "manual", name: "payment-declined" } });
      }
      await insertTestTimeline(db, projectId, { reason: { type: "error", message: "x".repeat(400) } });

      const { topReasons } = await summarizeTimelines(db, projectId, ALL, "UTC");

      expect(topReasons.map((r) => [r.type, r.name, r.count])).toEqual([
        ["error", "TypeError", 3],
        ["manual", "payment-declined", 2],
        ["error", null, 1],
      ]);
      expect(topReasons[1].message).toBeNull();
      expect(topReasons[2].message).toBe("x".repeat(300));
      expect(topReasons[0].key).toMatch(/^[0-9a-f]{32}$/);
      expect(topReasons[0].lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });

    it("feeds a top-reason key back into the list filter, including a group with no name", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      for (let i = 0; i < 2; i++) {
        await insertTestTimeline(db, projectId, { reason: { type: "error", name: "TypeError", message: "a" } });
      }
      const nameless = await insertTestTimeline(db, projectId, { reason: { type: "error", message: "a" } });

      const { topReasons } = await summarizeTimelines(db, projectId, ALL, "UTC");
      const namelessKey = topReasons.find((r) => r.name === null)?.key;
      const typeErrorKey = topReasons.find((r) => r.name === "TypeError")?.key;

      const list = async (reason: string | undefined) => (await listTimelines(db, projectId, { ...ALL, reason }, PAGE)).timelines;
      expect((await list(namelessKey)).map((t) => t.id)).toEqual([nameless]);
      expect(await list(typeErrorKey)).toHaveLength(2);
      expect(await list("0".repeat(32))).toEqual([]);
    });

    it("applies the filters to buckets and top reasons", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestTimeline(db, projectId, { tags: ["checkout"] });
      await insertTestTimeline(db, projectId, { tags: ["video_player"] });

      const summary = await summarizeTimelines(db, projectId, { ...ALL, tags: ["checkout"] }, "UTC");

      expect(summary.buckets.reduce((sum, b) => sum + b.error, 0)).toBe(1);
      expect(summary.topReasons.map((r) => r.count)).toEqual([1]);
    });

    it("reports projectHasTimelines regardless of the filters", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      expect((await summarizeTimelines(db, projectId, ALL, "UTC")).projectHasTimelines).toBe(false);

      await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(10 * DAY) });
      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "24h" }, "UTC");
      expect(summary.projectHasTimelines).toBe(true);
      expect(summary.buckets.every((b) => b.error + b.manual + b.unhandledrejection === 0)).toBe(true);
    });
  });

  describe("listTags", () => {
    it("counts the range's tags, most used first, for this project only", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      await insertTestTimeline(db, projectId, { tags: ["checkout", "payments"] });
      await insertTestTimeline(db, projectId, { tags: ["checkout"] });
      await insertTestTimeline(db, projectId, { tags: ["video_player"], receivedAt: pgTimestampAgo(3 * DAY) });
      await insertTestTimeline(db, otherId, { tags: ["elsewhere"] });

      expect(await listTags(db, projectId, "7d")).toEqual([
        { tag: "checkout", count: 2 },
        { tag: "payments", count: 1 },
        { tag: "video_player", count: 1 },
      ]);
      expect((await listTags(db, projectId, "24h")).map((t) => t.tag)).toEqual(["checkout", "payments"]);
    });
  });

  describe("getTimeline", () => {
    it("returns the whole timeline and its siblings from the same session and project", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      const first = await insertTestTimeline(db, projectId, { sessionId: "s1", receivedAt: pgTimestampAgo(3 * HOUR), reason: { type: "manual", name: "earlier" } });
      const id = await insertTestTimeline(db, projectId, { sessionId: "s1", tags: ["checkout"], receivedAt: pgTimestampAgo(2 * HOUR) });
      const later = await insertTestTimeline(db, projectId, { sessionId: "s1", receivedAt: pgTimestampAgo(HOUR) });
      await insertTestTimeline(db, projectId, { sessionId: "s2" });
      await insertTestTimeline(db, otherId, { sessionId: "s1" });

      const found = await getTimeline(db, projectId, id);

      expect(found?.timeline).toMatchObject({
        id,
        sessionId: "s1",
        tags: ["checkout"],
        reason: { type: "error", name: "TypeError", message: "boom" },
        events: [{ timestamp: 1, type: "custom", name: "step" }],
        meta: { url: "https://shop.example.com/checkout", userAgent: "test-agent", capturedAt: 1 },
      });
      expect(found?.siblings.map((s) => s.id)).toEqual([first, later]);
      expect(found?.siblings[0]).toMatchObject({ reasonType: "manual", reasonName: "earlier" });
    });

    it("returns undefined for a timeline in another project", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      const theirs = await insertTestTimeline(db, otherId);
      expect(await getTimeline(db, projectId, theirs)).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w server -- src/db/timelines.test.ts`
Expected: FAIL. `./timelines` doesn't exist.

- [ ] **Step 3: Implement the service**

Create `server/src/db/timelines.ts`:

```ts
import { and, arrayOverlaps, asc, desc, eq, inArray, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { isUuid } from "../uuid";
import type { Database } from "./client";
import { timelines } from "./schema";

export const RANGES = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" } as const;
export type Range = keyof typeof RANGES;

export const REASON_TYPES = ["error", "unhandledrejection", "manual"] as const;
export type ReasonType = (typeof REASON_TYPES)[number];

export interface TimelineFilters {
  range: Range;
  /** Empty means every type. */
  reasonTypes: ReasonType[];
  /** Matched as any-of. Empty means no tag filter. */
  tags: string[];
  /** A top-reasons key (see REASON_KEY). */
  reason?: string;
}

export interface Cursor {
  /** receivedAt exactly as the list returned it, microseconds included. */
  receivedAt: string;
  id: string;
}

export interface TimelineListRow {
  id: string;
  receivedAt: string;
  sessionId: string;
  reasonType: string;
  reasonName: string | null;
  reasonMessage: string | null;
  url: string | null;
  tags: string[];
  eventCount: number;
}

export interface TimelinePage {
  timelines: TimelineListRow[];
  nextCursor: string | null;
}

export interface VolumeBucket {
  start: string;
  error: number;
  unhandledrejection: number;
  manual: number;
}

export interface TopReason {
  key: string;
  type: string;
  name: string | null;
  message: string | null;
  count: number;
  lastSeen: string;
}

export interface TimelineSummary {
  projectHasTimelines: boolean;
  bucket: "hour" | "day";
  buckets: VolumeBucket[];
  topReasons: TopReason[];
}

// A type alias, not an interface, so it satisfies db.execute's row constraint.
export type TagCount = { tag: string; count: number };

// received_at holds UTC wall-clock time. This renders it as ISO-8601 with all six
// fractional digits; a JS Date would drop the last three.
function isoTimestamp(value: AnyColumn | SQL): SQL<string> {
  return sql<string>`to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const REASON_NAME = sql<string | null>`${timelines.reason}->>'name'`;
const REASON_MESSAGE = sql<string | null>`${timelines.reason}->>'message'`;
const MESSAGE_PREVIEW = sql<string | null>`left(${REASON_MESSAGE}, 300)`;
// Built only from expressions that top reasons GROUP BY, with no bound
// parameters, so Postgres accepts it in that query's select list.
const REASON_KEY = sql<string>`md5(jsonb_build_array(${timelines.reasonType}, ${REASON_NAME}, ${REASON_MESSAGE})::text)`;

function whereAll(conditions: SQL[]): SQL {
  return sql.join(
    conditions.map((condition) => sql`(${condition})`),
    sql` AND `
  );
}

// The one place filters become SQL; the list, the summary and the tag list all
// start from it, so they can't disagree about what a filter means.
function filterConditions(projectId: string, filters: TimelineFilters): SQL[] {
  const conditions: SQL[] = [
    eq(timelines.projectId, projectId),
    sql`${timelines.receivedAt} >= (now() AT TIME ZONE 'UTC') - ${RANGES[filters.range]}::interval`,
  ];
  if (filters.reasonTypes.length > 0) {
    conditions.push(inArray(timelines.reasonType, filters.reasonTypes));
  }
  if (filters.tags.length > 0) {
    conditions.push(arrayOverlaps(timelines.tags, filters.tags));
  }
  if (filters.reason !== undefined) {
    conditions.push(sql`${REASON_KEY} = ${filters.reason}`);
  }
  return conditions;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.receivedAt}|${cursor.id}`, "utf8").toString("base64url");
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** The cursor, or undefined if the value isn't one this server made. */
export function decodeCursor(value: string): Cursor | undefined {
  const parts = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (parts.length !== 2) {
    return undefined;
  }
  const [receivedAt, id] = parts;
  return CURSOR_TIMESTAMP.test(receivedAt) && isUuid(id) ? { receivedAt, id } : undefined;
}

export async function listTimelines(
  db: Database,
  projectId: string,
  filters: TimelineFilters,
  page: { cursor?: Cursor; limit: number }
): Promise<TimelinePage> {
  const conditions = filterConditions(projectId, filters);
  if (page.cursor) {
    // Postgres ignores the cursor's trailing "Z" when casting to timestamp.
    conditions.push(
      sql`(${timelines.receivedAt}, ${timelines.id}) < (${page.cursor.receivedAt}::timestamp, ${page.cursor.id}::uuid)`
    );
  }

  const rows = await db
    .select({
      id: timelines.id,
      receivedAt: isoTimestamp(timelines.receivedAt),
      sessionId: timelines.sessionId,
      reasonType: timelines.reasonType,
      reasonName: REASON_NAME,
      reasonMessage: MESSAGE_PREVIEW,
      url: sql<string | null>`${timelines.meta}->>'url'`,
      tags: timelines.tags,
      eventCount: sql<number>`jsonb_array_length(${timelines.events})`,
    })
    .from(timelines)
    .where(whereAll(conditions))
    .orderBy(desc(timelines.receivedAt), desc(timelines.id))
    .limit(page.limit + 1);

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    timelines: pageRows,
    nextCursor: hasMore && last ? encodeCursor({ receivedAt: last.receivedAt, id: last.id }) : null,
  };
}

export async function summarizeTimelines(
  db: Database,
  projectId: string,
  filters: TimelineFilters,
  timeZone: string
): Promise<TimelineSummary> {
  const unit = filters.range === "24h" ? "hour" : "day";
  const where = whereAll(filterConditions(projectId, filters));
  const [projectHasTimelines, buckets, topReasons] = await Promise.all([
    hasAnyTimeline(db, projectId),
    volume(db, where, filters.range, unit, timeZone),
    topReasonsWhere(db, where),
  ]);
  return { projectHasTimelines, bucket: unit, buckets, topReasons };
}

async function hasAnyTimeline(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db.select({ id: timelines.id }).from(timelines).where(eq(timelines.projectId, projectId)).limit(1);
  return row !== undefined;
}

// Buckets run from the one holding now − range to the one holding now, cut in
// `timeZone`, with empty ones zero-filled. `start` is returned as a UTC instant.
async function volume(db: Database, where: SQL, range: Range, unit: "hour" | "day", timeZone: string): Promise<VolumeBucket[]> {
  const result = await db.execute<{ start_ms: number; error: number; unhandledrejection: number; manual: number }>(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc(${unit}::text, (now() AT TIME ZONE ${timeZone}::text) - ${RANGES[range]}::interval),
        date_trunc(${unit}::text, now() AT TIME ZONE ${timeZone}::text),
        ${`1 ${unit}`}::interval
      ) AS bucket
    ),
    counts AS (
      SELECT date_trunc(${unit}::text, (${timelines.receivedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text) AS bucket,
             ${timelines.reasonType} AS reason_type,
             count(*)::int AS n
      FROM ${timelines}
      WHERE ${where}
      GROUP BY 1, 2
    )
    SELECT (extract(epoch FROM series.bucket AT TIME ZONE ${timeZone}::text) * 1000)::float8 AS start_ms,
           coalesce(sum(counts.n) FILTER (WHERE counts.reason_type = 'error'), 0)::int AS error,
           coalesce(sum(counts.n) FILTER (WHERE counts.reason_type = 'unhandledrejection'), 0)::int AS unhandledrejection,
           coalesce(sum(counts.n) FILTER (WHERE counts.reason_type = 'manual'), 0)::int AS manual
    FROM series
    LEFT JOIN counts ON counts.bucket = series.bucket
    GROUP BY series.bucket
    ORDER BY series.bucket
  `);
  return result.rows.map((row) => ({
    start: new Date(row.start_ms).toISOString(),
    error: row.error,
    unhandledrejection: row.unhandledrejection,
    manual: row.manual,
  }));
}

async function topReasonsWhere(db: Database, where: SQL): Promise<TopReason[]> {
  const count = sql<number>`count(*)::int`;
  const lastSeen = sql`max(${timelines.receivedAt})`;
  return db
    .select({
      key: REASON_KEY,
      type: timelines.reasonType,
      name: REASON_NAME,
      message: MESSAGE_PREVIEW,
      count,
      lastSeen: isoTimestamp(lastSeen),
    })
    .from(timelines)
    .where(where)
    .groupBy(timelines.reasonType, REASON_NAME, REASON_MESSAGE)
    .orderBy(desc(count), desc(lastSeen))
    .limit(10);
}

/** Distinct tags in the range with counts. Ignores every filter but the range. */
export async function listTags(db: Database, projectId: string, range: Range): Promise<TagCount[]> {
  const where = whereAll(filterConditions(projectId, { range, reasonTypes: [], tags: [] }));
  const result = await db.execute<TagCount>(sql`
    SELECT tag, count(*)::int AS count
    FROM ${timelines}, unnest(${timelines.tags}) AS tag
    WHERE ${where}
    GROUP BY tag
    ORDER BY count DESC, tag
    LIMIT 100
  `);
  return result.rows;
}

export async function getTimeline(db: Database, projectId: string, timelineId: string) {
  const [timeline] = await db
    .select({
      id: timelines.id,
      receivedAt: isoTimestamp(timelines.receivedAt),
      sessionId: timelines.sessionId,
      tags: timelines.tags,
      reason: timelines.reason,
      events: timelines.events,
      meta: timelines.meta,
    })
    .from(timelines)
    .where(and(eq(timelines.projectId, projectId), eq(timelines.id, timelineId)));
  if (!timeline) {
    return undefined;
  }

  const siblings = await db
    .select({
      id: timelines.id,
      receivedAt: isoTimestamp(timelines.receivedAt),
      reasonType: timelines.reasonType,
      reasonName: REASON_NAME,
    })
    .from(timelines)
    .where(
      and(eq(timelines.projectId, projectId), eq(timelines.sessionId, timeline.sessionId), ne(timelines.id, timelineId))
    )
    .orderBy(asc(timelines.receivedAt), asc(timelines.id))
    .limit(20);

  return { timeline, siblings };
}
```

If Postgres rejects the top-reasons query with `column "timelines.reason" must appear in the GROUP BY clause`, the select-list expressions and the `GROUP BY` expressions have stopped rendering identically. That happens, for example, if someone interpolates a JS value such as `${300}` into `MESSAGE_PREVIEW`, which turns it into a bound parameter. Keep those fragments free of parameters. Don't work around it with a subquery.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w server -- src/db/timelines.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

```bash
git add server/src/db/timelines.ts server/src/db/timelines.test.ts
git commit -m "feat(server): timeline read service: filters, keyset list, summary, tags, detail"
```

---

### Task 4: Timeline read routes

**Files:**
- Create: `server/src/routes/timelines.ts`, `server/src/routes/timelines.test.ts`
- Modify: `server/src/routes/projects.ts`, `server/src/app.ts`, `server/src/routes/isolation.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `server/src/routes/timelines.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createTestProject,
  createTestUser,
  getTestDb,
  insertTestTimeline,
  resetDb,
  sessionCookie,
} from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { addMember, createOrgWithOwner } from "../db/orgs";

async function fixture() {
  const db = getTestDb();
  const owner = await createTestUser(db);
  const member = await createTestUser(db);
  const org = await createOrgWithOwner(db, owner.id, "Acme");
  await addMember(db, org.id, member.id, "member");
  const { project } = await createTestProject(db, "web", org.id);
  const { project: sibling } = await createTestProject(db, "api", org.id);
  const app = await buildTestApp(db);
  return {
    db,
    app,
    project,
    sibling,
    // Members (not just owners) read timelines.
    cookie: await sessionCookie(db, member.id),
    base: `/api/orgs/${org.id}/projects/${project.id}/timelines`,
  };
}

describe("timeline read routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("lists timelines, taking repeated and single-valued array params", async () => {
    const { db, app, project, cookie, base } = await fixture();
    const tagged = await insertTestTimeline(db, project.id, { tags: ["checkout"] });
    await insertTestTimeline(db, project.id, { reason: { type: "manual", name: "m" }, tags: ["video_player"] });

    const both = await call(app, "GET", `${base}?reasonType=error&reasonType=manual&tag=checkout`, { cookie });
    expect(both.statusCode).toBe(200);
    expect(both.json().timelines.map((t: { id: string }) => t.id)).toEqual([tagged]);

    const single = await call(app, "GET", `${base}?reasonType=manual`, { cookie });
    expect(single.json().timelines).toHaveLength(1);
  });

  it("pages with nextCursor", async () => {
    const { db, app, project, cookie, base } = await fixture();
    for (let i = 0; i < 3; i++) {
      await insertTestTimeline(db, project.id);
    }

    const first = (await call(app, "GET", `${base}?limit=2`, { cookie })).json();
    expect(first.timelines).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (await call(app, "GET", `${base}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, { cookie })).json();
    expect(second.timelines).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    "range=1y",
    "reasonType=fatal",
    "tag=Checkout",
    "reason=abc",
    "limit=0",
    "limit=101",
    "cursor=garbage",
    "unknown=1",
  ])("returns 400 for ?%s", async (query) => {
    const { app, cookie, base } = await fixture();
    const response = await call(app, "GET", `${base}?${query}`, { cookie });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
  });

  it("summarizes in the requested time zone and rejects an unknown one", async () => {
    const { db, app, project, cookie, base } = await fixture();
    await insertTestTimeline(db, project.id);

    const bad = await call(app, "GET", `${base}/summary?tz=Not%2FA_Zone`, { cookie });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "Invalid time zone" });

    const good = await call(app, "GET", `${base}/summary?tz=Europe%2FWarsaw`, { cookie });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({ projectHasTimelines: true, bucket: "day" });
    expect(good.json().buckets).toHaveLength(8);
    expect(good.json().topReasons).toHaveLength(1);
  });

  it("lists tags, and takes only range", async () => {
    const { db, app, project, cookie, base } = await fixture();
    await insertTestTimeline(db, project.id, { tags: ["checkout"] });

    const response = await call(app, "GET", `${base}/tags?range=24h`, { cookie });
    expect(response.json()).toEqual({ tags: [{ tag: "checkout", count: 1 }] });

    expect((await call(app, "GET", `${base}/tags?reasonType=error`, { cookie })).statusCode).toBe(400);
  });

  it("returns one timeline, and 404 for a malformed id or another project's timeline", async () => {
    const { db, app, project, sibling, cookie, base } = await fixture();
    const id = await insertTestTimeline(db, project.id);
    const theirs = await insertTestTimeline(db, sibling.id);

    const found = await call(app, "GET", `${base}/${id}`, { cookie });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ timeline: { id }, siblings: [] });

    for (const bad of ["not-a-uuid", theirs]) {
      const response = await call(app, "GET", `${base}/${bad}`, { cookie });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not Found" });
    }
  });

  it("requires a session", async () => {
    const { app, base } = await fixture();
    expect((await call(app, "GET", base)).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w server -- src/routes/timelines.test.ts`
Expected: FAIL. Every route returns `404`.

- [ ] **Step 3: Share the project check**

In `server/src/routes/projects.ts`:

1. Add `import type { Database } from "../db/client";`.
2. Replace the local `type ProjectParams = OrgParams & { projectId: string };` with an export, and add an exported `requireProject` above `registerProjectRoutes`:

```ts
export type ProjectParams = OrgParams & { projectId: string };
```

```ts
/** 404 unless the project exists in the org. Every project-scoped route calls it first. */
export async function requireProject(db: Database, { orgId, projectId }: ProjectParams): Promise<void> {
  if (!isUuid(projectId) || !(await findProjectInOrg(db, orgId, projectId))) {
    throw httpError(404, "Not Found");
  }
}
```

3. Delete the inner `async function requireProject(…)` from `registerProjectRoutes`, and change its two callers to `await requireProject(db, request.params);`.

- [ ] **Step 4: Implement the routes**

Create `server/src/routes/timelines.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { requireMembership, requireUser } from "../auth/http";
import {
  decodeCursor,
  getTimeline,
  listTags,
  listTimelines,
  RANGES,
  REASON_TYPES,
  summarizeTimelines,
  type Range,
  type ReasonType,
  type TimelineFilters,
} from "../db/timelines";
import { MAX_TAGS, tagSchema } from "../tags";
import { isUuid } from "../uuid";
import type { ApiContext } from "./context";
import { httpError } from "./errors";
import { requireProject, type ProjectParams } from "./projects";

interface FilterQuery {
  range: Range;
  reasonType?: ReasonType[];
  tag?: string[];
  reason?: string;
}

const rangeSchema = { type: "string", enum: Object.keys(RANGES), default: "7d" };

// Arrays because Fastify's Ajv coerces a single ?tag=a into ["a"].
const filterProperties = {
  range: rangeSchema,
  reasonType: { type: "array", maxItems: REASON_TYPES.length, items: { type: "string", enum: REASON_TYPES } },
  tag: { type: "array", maxItems: MAX_TAGS, items: tagSchema },
  reason: { type: "string", pattern: "^[0-9a-f]{32}$" },
};

function querySchema(properties: Record<string, unknown>) {
  return { type: "object", properties, additionalProperties: false };
}

const TIME_ZONE_SHAPE = /^[A-Za-z0-9_+\-/]{1,64}$/;

// Intl validates against the same IANA database Postgres uses. The shape check
// keeps anything else (POSIX zone strings, SQL) away from AT TIME ZONE.
export function isTimeZone(value: string): boolean {
  if (!TIME_ZONE_SHAPE.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function filtersFrom(query: FilterQuery): TimelineFilters {
  return { range: query.range, reasonTypes: query.reasonType ?? [], tags: query.tag ?? [], reason: query.reason };
}

// Read-only, for owners and members alike. preValidation (auth) runs before the
// querystring is validated, so a non-member gets 404 even with a bad query.
export function registerTimelineReadRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const asMember = [requireUser(db), requireMembership(db, "member")];
  const base = "/api/orgs/:orgId/projects/:projectId/timelines";

  app.get<{ Params: ProjectParams; Querystring: FilterQuery & { cursor?: string; limit: number } }>(
    base,
    {
      preValidation: asMember,
      schema: {
        querystring: querySchema({
          ...filterProperties,
          cursor: { type: "string", maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        }),
      },
    },
    async (request) => {
      await requireProject(db, request.params);
      const { cursor, limit } = request.query;
      const decoded = cursor === undefined ? undefined : decodeCursor(cursor);
      if (cursor !== undefined && !decoded) {
        throw httpError(400, "Invalid cursor");
      }
      return listTimelines(db, request.params.projectId, filtersFrom(request.query), { cursor: decoded, limit });
    }
  );

  app.get<{ Params: ProjectParams; Querystring: FilterQuery & { tz: string } }>(
    `${base}/summary`,
    {
      preValidation: asMember,
      schema: { querystring: querySchema({ ...filterProperties, tz: { type: "string", default: "UTC" } }) },
    },
    async (request) => {
      await requireProject(db, request.params);
      if (!isTimeZone(request.query.tz)) {
        throw httpError(400, "Invalid time zone");
      }
      return summarizeTimelines(db, request.params.projectId, filtersFrom(request.query), request.query.tz);
    }
  );

  app.get<{ Params: ProjectParams; Querystring: { range: Range } }>(
    `${base}/tags`,
    { preValidation: asMember, schema: { querystring: querySchema({ range: rangeSchema }) } },
    async (request) => {
      await requireProject(db, request.params);
      return { tags: await listTags(db, request.params.projectId, request.query.range) };
    }
  );

  app.get<{ Params: ProjectParams & { timelineId: string } }>(
    `${base}/:timelineId`,
    { preValidation: asMember },
    async (request) => {
      await requireProject(db, request.params);
      const { projectId, timelineId } = request.params;
      const found = isUuid(timelineId) ? await getTimeline(db, projectId, timelineId) : undefined;
      if (!found) {
        throw httpError(404, "Not Found");
      }
      return found;
    }
  );
}
```

`/timelines/summary` and `/timelines/tags` are static segments. Fastify's router always prefers them over `/:timelineId`, whatever the registration order.

In `server/src/app.ts`, import and register the routes after the project routes:

```ts
import { registerTimelineReadRoutes } from "./routes/timelines";
```

```ts
  registerProjectRoutes(app, ctx);
  registerTimelineReadRoutes(app, ctx);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -w server -- src/routes/timelines.test.ts src/routes/projects.test.ts`
Expected: PASS. The project route tests still pass after the `requireProject` refactor.

- [ ] **Step 6: Extend the tenant-isolation test**

Run: `npm test -w server -- src/routes/isolation.test.ts`
Expected: FAIL. "covers every registered org-scoped route" now sees four routes that aren't in `CASES`.

In `server/src/routes/isolation.test.ts`:

1. Add `insertTestTimeline` to the `../../test/db` import.
2. Add `timelineId: string;` to the `Fixture` interface.
3. In `setup()`, after the project is created, add `const timelineId = await insertTestTimeline(db, project.id);`, and add `timelineId` to the `victim` object.
4. Add these cases to `CASES`, before the final `DELETE /api/orgs/:orgId/members/:userId` entry:

```ts
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines`,
  },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines/summary",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines/summary`,
  },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines/tags",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines/tags`,
  },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines/:timelineId",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines/${f.timelineId}`,
  },
```

Run: `npm test -w server -- src/routes/isolation.test.ts`
Expected: PASS. An outsider gets `404` on all four routes, crossing through their own org id also gets `404`, and the owner reaches them.

- [ ] **Step 7: Whole server check and commit**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

```bash
git add server
git commit -m "feat(server): timeline read routes behind org membership"
```

---

### Task 5: Dashboard foundations: types, filters, queries, formatting, tokens, project tabs

**Files:**
- Create: `dashboard/src/timelineFilters.ts`, `dashboard/src/timelineFilters.test.ts`, `dashboard/src/format.test.ts`, `dashboard/src/pages/ProjectLayout.tsx`, `dashboard/src/pages/ProjectKeysPage.tsx`, `dashboard/src/pages/TimelinesPage.tsx` (placeholder, replaced in Task 7)
- Modify: `dashboard/src/types.ts`, `dashboard/src/queries.ts`, `dashboard/src/format.ts`, `dashboard/src/index.css`, `dashboard/src/components/ui.tsx`, `dashboard/src/components/OnceSecret.tsx`, `dashboard/src/App.tsx`, `dashboard/src/test/utils.tsx`, `dashboard/src/pages/projects.test.tsx`
- Delete: `dashboard/src/pages/ProjectPage.tsx`

- [ ] **Step 1: Add the response types**

Append to `dashboard/src/types.ts`:

```ts
export type ReasonType = "error" | "unhandledrejection" | "manual";
export type Range = "24h" | "7d" | "30d";

export interface TimelineRow {
  id: string;
  receivedAt: string;
  sessionId: string;
  reasonType: ReasonType;
  reasonName: string | null;
  reasonMessage: string | null;
  url: string | null;
  tags: string[];
  eventCount: number;
}

export interface TimelinePage {
  timelines: TimelineRow[];
  nextCursor: string | null;
}

export interface VolumeBucket {
  start: string;
  error: number;
  unhandledrejection: number;
  manual: number;
}

export interface TopReason {
  key: string;
  type: ReasonType;
  name: string | null;
  message: string | null;
  count: number;
  lastSeen: string;
}

export interface TimelineSummary {
  projectHasTimelines: boolean;
  bucket: "hour" | "day";
  buckets: VolumeBucket[];
  topReasons: TopReason[];
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface TimelineEvent {
  timestamp: number;
  type: "custom" | "error" | "unhandledrejection" | "trace";
  name: string;
  data?: Record<string, unknown>;
}

export interface TimelineDetail {
  timeline: {
    id: string;
    receivedAt: string;
    sessionId: string;
    tags: string[];
    reason: { type: ReasonType; name?: string; message?: string; data?: Record<string, unknown> };
    events: TimelineEvent[];
    meta: { url: string; userAgent: string; capturedAt: number };
  };
  siblings: { id: string; receivedAt: string; reasonType: ReasonType; reasonName: string | null }[];
}
```

- [ ] **Step 2: Write the failing filter and format tests**

Create `dashboard/src/timelineFilters.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filtersFromParams, filtersToParams } from "./timelineFilters";

describe("timeline filters", () => {
  it("defaults to 7 days and everything", () => {
    expect(filtersFromParams(new URLSearchParams())).toEqual({ range: "7d", reasonTypes: [], tags: [], reason: null });
  });

  it("reads repeated params, in a stable order", () => {
    const params = new URLSearchParams("range=24h&reasonType=manual&reasonType=error&tag=checkout&tag=payments&reason=" + "a".repeat(32));
    expect(filtersFromParams(params)).toEqual({
      range: "24h",
      reasonTypes: ["error", "manual"],
      tags: ["checkout", "payments"],
      reason: "a".repeat(32),
    });
  });

  it("drops values the API would reject instead of sending them", () => {
    const params = new URLSearchParams("range=1y&reasonType=fatal&tag=Checkout&tag=ok&tag=ok&reason=nope");
    expect(filtersFromParams(params)).toEqual({ range: "7d", reasonTypes: [], tags: ["ok"], reason: null });
  });

  it("leaves defaults out when writing params", () => {
    expect(filtersToParams({ range: "7d", reasonTypes: [], tags: [], reason: null }).toString()).toBe("");
    expect(filtersToParams({ range: "30d", reasonTypes: ["error"], tags: ["a", "b"], reason: null }).toString()).toBe(
      "range=30d&reasonType=error&tag=a&tag=b"
    );
  });
});
```

Create `dashboard/src/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatOffset, safeHref, urlPath } from "./format";

describe("formatOffset", () => {
  it.each([
    [0, "0.0s"],
    [-12_400, "−12.4s"],
    [-185_000, "−3m 05s"],
    [-3_720_000, "−1h 02m"],
    [1_500, "+1.5s"],
  ])("%i ms → %s", (ms, text) => {
    expect(formatOffset(ms)).toBe(text);
  });
});

describe("safeHref", () => {
  it("links http and https only", () => {
    expect(safeHref("https://shop.example.com/a?b=1")).toBe("https://shop.example.com/a?b=1");
    expect(safeHref("http://localhost:3000/")).toBe("http://localhost:3000/");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,hi")).toBeUndefined();
    expect(safeHref("not a url")).toBeUndefined();
  });
});

describe("urlPath", () => {
  it("shows the path and query, or the raw value if it isn't a URL", () => {
    expect(urlPath("https://shop.example.com/cart?step=2")).toBe("/cart?step=2");
    expect(urlPath("weird")).toBe("weird");
    expect(urlPath(null)).toBe("");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npm test -w dashboard -- src/timelineFilters.test.ts src/format.test.ts`
Expected: FAIL. The modules and exports don't exist yet.

- [ ] **Step 4: Implement filters and formatting**

Create `dashboard/src/timelineFilters.ts`:

```ts
import { useSearchParams } from "react-router";
import type { Range, ReasonType } from "./types";

export const RANGES: Range[] = ["24h", "7d", "30d"];
export const REASON_TYPES: ReasonType[] = ["error", "unhandledrejection", "manual"];
const DEFAULT_RANGE: Range = "7d";
// The server's tag rule. A hand-edited URL with an invalid tag drops the tag
// instead of turning every request into a 400.
const TAG = /^[a-z0-9][a-z0-9_.:-]{0,49}$/;
const REASON_KEY = /^[0-9a-f]{32}$/;

export interface TimelineFilters {
  range: Range;
  /** Empty means every type. */
  reasonTypes: ReasonType[];
  /** Any-of. */
  tags: string[];
  /** A top-reasons key. */
  reason: string | null;
}

export function filtersFromParams(params: URLSearchParams): TimelineFilters {
  const range = params.get("range") as Range | null;
  const reason = params.get("reason");
  return {
    range: range !== null && RANGES.includes(range) ? range : DEFAULT_RANGE,
    // Filtered from REASON_TYPES so the order (and the query key) is stable.
    reasonTypes: REASON_TYPES.filter((type) => params.getAll("reasonType").includes(type)),
    tags: [...new Set(params.getAll("tag").filter((tag) => TAG.test(tag)))].slice(0, 10),
    reason: reason !== null && REASON_KEY.test(reason) ? reason : null,
  };
}

/** Params for the page URL and the API alike. Defaults are left out. */
export function filtersToParams(filters: TimelineFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.range !== DEFAULT_RANGE) {
    params.set("range", filters.range);
  }
  filters.reasonTypes.forEach((type) => params.append("reasonType", type));
  filters.tags.forEach((tag) => params.append("tag", tag));
  if (filters.reason) {
    params.set("reason", filters.reason);
  }
  return params;
}

/** The filters in the URL, and a setter that replaces the history entry. */
export function useTimelineFilters(): [TimelineFilters, (changes: Partial<TimelineFilters>) => void] {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const update = (changes: Partial<TimelineFilters>) =>
    setParams(filtersToParams({ ...filters, ...changes }), { replace: true });
  return [filters, update];
}
```

Append to `dashboard/src/format.ts`:

```ts
import type { ReasonType } from "./types";

export const REASON_LABELS: Record<ReasonType, string> = {
  error: "Error",
  unhandledrejection: "Unhandled rejection",
  manual: "Manual",
};

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "3 minutes ago", "yesterday"; the absolute time belongs in a title. */
export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return relative.format(seconds, "second");
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86400), "day");
}

/** An event's time relative to the capture: "−12.4s", "−3m 05s", "−1h 02m". */
export function formatOffset(ms: number): string {
  const sign = ms < 0 ? "−" : ms > 0 ? "+" : "";
  const abs = Math.abs(ms);
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(1)}s`;
  const seconds = Math.floor(abs / 1000);
  if (abs < 3_600_000) return `${sign}${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${sign}${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
}

/** Path and query of a captured URL, or the raw value if it doesn't parse. */
export function urlPath(url: string | null): string {
  if (url === null) return "";
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

/** An href only for http(s) URLs. Captured URLs come from browsers and are untrusted. */
export function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
```

Move the new `import type` line to the top of `format.ts`, above `formatDate`.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test -w dashboard -- src/timelineFilters.test.ts src/format.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the queries**

In `dashboard/src/queries.ts`, change the imports:

```ts
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { filtersToParams, type TimelineFilters } from "./timelineFilters";
import type {
  ApiKey,
  AuthConfig,
  Invite,
  Me,
  Member,
  Project,
  Range,
  Role,
  TagCount,
  TimelineDetail,
  TimelinePage,
  TimelineSummary,
} from "./types";
```

Add to `queryKeys`:

```ts
  timelines: (orgId: string, projectId: string) => ["orgs", orgId, "projects", projectId, "timelines"] as const,
```

Append:

```ts
function timelinesPath(orgId: string, projectId: string, suffix = "", params?: URLSearchParams): string {
  const query = params?.toString();
  return `/api/orgs/${orgId}/projects/${projectId}/timelines${suffix}${query ? `?${query}` : ""}`;
}

/** The viewer's IANA time zone; the summary cuts days at its midnight. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function useTimelines(orgId: string, projectId: string, filters: TimelineFilters) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "list", filters],
    queryFn: ({ pageParam }) => {
      const params = filtersToParams(filters);
      if (pageParam) params.set("cursor", pageParam);
      return api<TimelinePage>("GET", timelinesPath(orgId, projectId, "", params));
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useTimelineSummary(orgId: string, projectId: string, filters: TimelineFilters) {
  const timeZone = viewerTimeZone();
  return useQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "summary", filters, timeZone],
    queryFn: () => {
      const params = filtersToParams(filters);
      params.set("tz", timeZone);
      return api<TimelineSummary>("GET", timelinesPath(orgId, projectId, "/summary", params));
    },
  });
}

export function useTimelineTags(orgId: string, projectId: string, range: Range) {
  return useQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "tags", range],
    queryFn: async () => {
      const params = range === "7d" ? undefined : new URLSearchParams({ range });
      return (await api<{ tags: TagCount[] }>("GET", timelinesPath(orgId, projectId, "/tags", params))).tags;
    },
  });
}

export function useTimeline(orgId: string, projectId: string, timelineId: string) {
  return useQuery({
    queryKey: [...queryKeys.timelines(orgId, projectId), "detail", timelineId],
    queryFn: () => api<TimelineDetail>("GET", timelinesPath(orgId, projectId, `/${timelineId}`)),
  });
}
```

- [ ] **Step 7: Add the series color tokens**

In `dashboard/src/index.css`, add to the `@theme` block, after `--color-danger`:

```css
  /* Chart series, one per reason type. Checked with the dataviz palette
     validator against the surfaces above (all pairs, light and dark). */
  --color-series-error: #4f46e5;
  --color-series-rejection: #eb6834;
  --color-series-manual: #1baf7a;
```

And to the dark `:root` block, after `--color-danger`:

```css
      --color-series-error: #7c83f5;
      --color-series-rejection: #d95926;
      --color-series-manual: #199e70;
```

- [ ] **Step 8: Add the small UI pieces**

Append to `dashboard/src/components/ui.tsx`:

```tsx
/** One-of-n buttons, e.g. a time range. Each button reports aria-pressed. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={`rounded px-2.5 py-1 text-sm ${option === value ? "bg-bg font-medium text-fg" : "text-muted hover:text-fg"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** A series' color next to its label. Identity never rests on color alone. */
export function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: color }} />;
}

export function Chip({ children, onRemove, removeLabel }: { children: ReactNode; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2 py-0.5 text-xs">
      {children}
      {onRemove && (
        <button type="button" aria-label={removeLabel} onClick={onRemove} className="text-muted hover:text-fg">
          ×
        </button>
      )}
    </span>
  );
}

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setCopied(true);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
```

In `dashboard/src/components/OnceSecret.tsx`, replace the inline copy `<Button …>{copied ? "Copied" : "Copy"}</Button>` with `<CopyButton value={value} />`. Remove the now-unused `copied` state and the `useState` import, and import `CopyButton` from `./ui` next to `Button`.

- [ ] **Step 9: Make `mockApi` match paths without their query**

In `dashboard/src/test/utils.tsx`, inside `mockApi`, replace:

```ts
      const handler = handlers[`${method} ${path}`];
```

with:

```ts
      // Exact "METHOD /path?query" first, then the path alone, so a test can
      // answer every query of one endpoint with a single handler.
      const handler = handlers[`${method} ${path}`] ?? handlers[`${method} ${path.split("?")[0]}`];
```

Update the doc comment above `mockApi` to say that it falls back to the path without its query string.

- [ ] **Step 10: Write the failing project-tab tests**

In `dashboard/src/pages/projects.test.tsx`:

1. Add empty timeline answers to `handlers()`, so the Timelines tab never hits an unhandled 404:

```ts
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/timelines`]: { body: { timelines: [], nextCursor: null } },
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/timelines/summary`]: {
      body: { projectHasTimelines: false, bucket: "day", buckets: [], topReasons: [] },
    },
    [`GET /api/orgs/${ORG_ID}/projects/proj-1/timelines/tags`]: { body: { tags: [] } },
```

2. In the `describe("project page", …)` block, change the three `renderApp(\`/orgs/${ORG_ID}/projects/proj-1\`)` calls to `renderApp(\`/orgs/${ORG_ID}/projects/proj-1/keys\`)`.

3. In "shows a new key once; it's gone after navigating away and back", replace the last two lines (`await screen.findByRole("heading", { name: "web" });` and the `expect`) with:

```tsx
    await user.click(await screen.findByRole("link", { name: "Keys" }));
    await screen.findByText("rpk_AbCdEfGh…");
    expect(screen.queryByText("rpk_second_full_key")).not.toBeInTheDocument();
```

4. Append to the `describe("project page", …)` block:

```tsx
  it("opens on the Timelines tab and switches to Keys", async () => {
    mockApi(handlers());
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/proj-1`);

    expect(await screen.findByRole("heading", { name: "web" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Timelines" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("link", { name: "Keys" }));
    await waitFor(() => expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects/proj-1/keys`));
    expect(await screen.findByText("rpk_AbCdEfGh…")).toBeInTheDocument();
  });

  it("says so for a project that isn't in the org", async () => {
    mockApi(handlers());
    renderApp(`/orgs/${ORG_ID}/projects/nope`);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeInTheDocument();
  });
```

- [ ] **Step 11: Run to verify they fail**

Run: `npm test -w dashboard -- src/pages/projects.test.tsx`
Expected: FAIL. `/keys` and the tabs don't exist yet.

- [ ] **Step 12: Split the project page**

Create `dashboard/src/pages/ProjectLayout.tsx`:

```tsx
import { Link, NavLink, Outlet, useParams } from "react-router";
import { Card, PageHeader } from "../components/ui";
import { useProjects } from "../queries";

export function ProjectNotFound({ orgId }: { orgId: string }) {
  return (
    <Card className="space-y-2">
      <h1 className="text-lg font-semibold">Project not found</h1>
      <Link to={`/orgs/${orgId}/projects`} className="text-sm text-accent hover:underline">
        All projects
      </Link>
    </Card>
  );
}

const tabClass = ({ isActive }: { isActive: boolean }) =>
  `-mb-px border-b-2 pb-2 text-sm ${isActive ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg"}`;

export function ProjectLayout() {
  const { orgId = "", projectId = "" } = useParams();
  const projects = useProjects(orgId);
  const project = projects.data?.find((p) => p.id === projectId);

  if (projects.data && !project) {
    return <ProjectNotFound orgId={orgId} />;
  }

  const base = `/orgs/${orgId}/projects/${projectId}`;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link to={`/orgs/${orgId}/projects`} className="text-sm text-muted hover:text-fg">
          ← All projects
        </Link>
        <PageHeader title={project?.name ?? "Project"} />
      </div>
      <nav className="flex gap-6 border-b border-border">
        <NavLink to={base} end className={tabClass}>
          Timelines
        </NavLink>
        <NavLink to={`${base}/keys`} className={tabClass}>
          Keys
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
```

Create `dashboard/src/pages/ProjectKeysPage.tsx`. This is `ProjectPage.tsx`'s body without the header, the 404 card and the Timelines placeholder, since the layout now owns those:

```tsx
import { useState } from "react";
import { useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { OnceSecret } from "../components/OnceSecret";
import { Button, Card, ConfirmButton, ErrorText } from "../components/ui";
import { formatDate } from "../format";
import { queryKeys, useKeys } from "../queries";
import type { CreatedApiKey } from "../types";

export function ProjectKeysPage() {
  const { orgId = "", projectId = "" } = useParams();
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

  return (
    <div className="space-y-6">
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
    </div>
  );
}
```

Create a placeholder `dashboard/src/pages/TimelinesPage.tsx`. Task 7 replaces it:

```tsx
import { Card } from "../components/ui";

export function TimelinesPage() {
  return (
    <Card className="space-y-1">
      <h2 className="font-medium">Timelines</h2>
      <p className="text-sm text-muted">Captured timelines will appear here.</p>
    </Card>
  );
}
```

Delete `dashboard/src/pages/ProjectPage.tsx`.

In `dashboard/src/App.tsx`, replace the `ProjectPage` import with:

```tsx
import { ProjectKeysPage } from "./pages/ProjectKeysPage";
import { ProjectLayout } from "./pages/ProjectLayout";
import { TimelinesPage } from "./pages/TimelinesPage";
```

and replace `<Route path="projects/:projectId" element={<ProjectPage />} />` with:

```tsx
            <Route path="projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<TimelinesPage />} />
              <Route path="keys" element={<ProjectKeysPage />} />
            </Route>
```

- [ ] **Step 13: Run the dashboard checks**

Run: `npm test -w dashboard && npm run typecheck -w dashboard && npm run lint -w dashboard`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add dashboard
git commit -m "feat(dashboard): project tabs, timeline queries, URL filters and chart tokens"
```

---

### Task 6: Charts

**Files:**
- Create: `dashboard/src/components/charts/scale.ts`, `series.ts`, `ChartFrame.tsx`, `StackedBars.tsx`, `Lines.tsx`, `VolumeChart.tsx`, `charts.test.tsx`

- [ ] **Step 1: Write the failing chart tests**

Create `dashboard/src/components/charts/charts.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TimelineSummary } from "../../types";
import { niceTicks } from "./scale";
import { SERIES } from "./series";
import { VolumeChart } from "./VolumeChart";

const SUMMARY: TimelineSummary = {
  projectHasTimelines: true,
  bucket: "day",
  buckets: [
    { start: "2026-09-20T00:00:00.000Z", error: 3, unhandledrejection: 1, manual: 0 },
    { start: "2026-09-21T00:00:00.000Z", error: 0, unhandledrejection: 0, manual: 0 },
    { start: "2026-09-22T00:00:00.000Z", error: 5, unhandledrejection: 0, manual: 2 },
  ],
  topReasons: [],
};

describe("niceTicks", () => {
  it.each([
    [0, [0, 1]],
    [1, [0, 1]],
    [3, [0, 1, 2, 3]],
    [7, [0, 2, 4, 6, 8]],
    [100, [0, 50, 100]],
    [101, [0, 50, 100, 150]],
  ])("%i → %j", (max, ticks) => {
    expect(niceTicks(max)).toEqual(ticks);
  });
});

describe("VolumeChart", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws stacked bars by default, one segment per non-zero count", () => {
    const { container } = render(<VolumeChart summary={SUMMARY} series={SERIES} />);
    expect(container.querySelectorAll('[data-series="error"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-series="unhandledrejection"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-series="manual"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Bars" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches to one line per series and remembers the choice", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(<VolumeChart summary={SUMMARY} series={SERIES} />);

    await user.click(screen.getByRole("button", { name: "Lines" }));
    expect(container.querySelectorAll("path[data-series]")).toHaveLength(3);

    unmount();
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);
    expect(screen.getByRole("button", { name: "Lines" })).toHaveAttribute("aria-pressed", "true");
  });

  it("falls back to bars when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);
    expect(screen.getByRole("button", { name: "Bars" })).toHaveAttribute("aria-pressed", "true");
  });

  it("draws and lists only the series it's given", () => {
    const { container } = render(<VolumeChart summary={SUMMARY} series={SERIES.filter((s) => s.key === "error")} />);
    expect(container.querySelectorAll('[data-series="manual"]')).toHaveLength(0);
    expect(within(screen.getByRole("list", { name: "Legend" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("shows each type's count and the total on hover", async () => {
    const user = userEvent.setup();
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);

    await user.hover(screen.getAllByTestId("chart-hover-target")[2]);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Error5");
    expect(tooltip).toHaveTextContent("Manual2");
    expect(tooltip).toHaveTextContent("Total7");
  });

  it("offers the same numbers as a table", async () => {
    const user = userEvent.setup();
    render(<VolumeChart summary={SUMMARY} series={SERIES} />);

    await user.click(screen.getByRole("button", { name: "Show table" }));

    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveTextContent(/5027$/);
  });
});
```

The last assertion relies on the row's cells rendering as "…date…", then `5`, `0`, `2`, `7`, with no whitespace between cells in `textContent`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w dashboard -- src/components/charts`
Expected: FAIL. The modules don't exist yet.

- [ ] **Step 3: Implement scale and series**

Create `dashboard/src/components/charts/scale.ts`:

```ts
/**
 * Round y-axis ticks from 0 up to at least `max`, in steps of 1, 2 or 5 × 10ⁿ,
 * never below 1 because counts are whole. Aims for about `target` steps.
 */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) {
    return [0, 1];
  }
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidate = [1, 2, 5, 10].map((m) => m * magnitude).find((step) => step >= rough) ?? 10 * magnitude;
  const step = Math.max(1, candidate);
  const ticks: number[] = [];
  for (let value = 0; ; value += step) {
    ticks.push(value);
    if (value >= max) {
      return ticks;
    }
  }
}
```

Create `dashboard/src/components/charts/series.ts`:

```ts
import { REASON_LABELS } from "../../format";
import type { ReasonType } from "../../types";

export interface SeriesDef {
  key: ReasonType;
  label: string;
  color: string;
}

export const SERIES_COLORS: Record<ReasonType, string> = {
  error: "var(--color-series-error)",
  unhandledrejection: "var(--color-series-rejection)",
  manual: "var(--color-series-manual)",
};

// A fixed order and color per reason type: filtering one out never repaints
// the others. Bars stack in this order, bottom first.
export const SERIES: SeriesDef[] = (["error", "unhandledrejection", "manual"] as const).map((key) => ({
  key,
  label: REASON_LABELS[key],
  color: SERIES_COLORS[key],
}));
```

- [ ] **Step 4: Implement the frame and the two mark layers**

Create `dashboard/src/components/charts/ChartFrame.tsx`:

```tsx
import type { ReactNode } from "react";

export const CHART_HEIGHT = 220;
export const MARGIN = { top: 8, right: 12, bottom: 24, left: 40 };

/** Plot-area coordinates; (0, 0) is the plot's top-left corner. */
export interface ChartGeometry {
  width: number;
  height: number;
  bandWidth: number;
  /** Left edge of bucket i's band. */
  x(i: number): number;
  /** Center of bucket i's band. */
  cx(i: number): number;
  y(value: number): number;
}

export function chartGeometry(width: number, count: number, yMax: number): ChartGeometry {
  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const bandWidth = count > 0 ? plotWidth / count : plotWidth;
  return {
    width: plotWidth,
    height: plotHeight,
    bandWidth,
    x: (i) => i * bandWidth,
    cx: (i) => i * bandWidth + bandWidth / 2,
    y: (value) => plotHeight - (value / yMax) * plotHeight,
  };
}

interface ChartFrameProps {
  width: number;
  geometry: ChartGeometry;
  ticks: number[];
  labels: string[];
  label: string;
  onHover: (index: number | null) => void;
  children: ReactNode;
}

// What both chart types share: a recessive grid with y ticks, sparse x labels,
// and one full-height hover target per bucket (larger than any mark). Marks are
// drawn by the children, in plot coordinates.
export function ChartFrame({ width, geometry: g, ticks, labels, label, onHover, children }: ChartFrameProps) {
  const every = Math.max(1, Math.ceil(labels.length / 6));
  return (
    <svg width={width} height={CHART_HEIGHT} role="img" aria-label={label} className="block">
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={0} x2={g.width} y1={g.y(tick)} y2={g.y(tick)} stroke="var(--color-border)" />
            <text x={-8} y={g.y(tick)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-muted)">
              {tick}
            </text>
          </g>
        ))}
        {children}
        {labels.map((text, i) =>
          i % every === 0 ? (
            <text key={i} x={g.cx(i)} y={g.height + 16} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
              {text}
            </text>
          ) : null
        )}
        <g onMouseLeave={() => onHover(null)}>
          {labels.map((_, i) => (
            <rect
              key={i}
              data-testid="chart-hover-target"
              x={g.x(i)}
              y={0}
              width={g.bandWidth}
              height={g.height}
              fill="transparent"
              onMouseEnter={() => onHover(i)}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
```

Create `dashboard/src/components/charts/StackedBars.tsx`:

```tsx
import type { VolumeBucket } from "../../types";
import type { ChartGeometry } from "./ChartFrame";
import type { SeriesDef } from "./series";

const GAP = 2; // surface-colored gap between stacked segments
const RADIUS = 4; // rounded data end; the base stays square on the baseline

function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function StackedBars({ g, buckets, series }: { g: ChartGeometry; buckets: VolumeBucket[]; series: SeriesDef[] }) {
  const barWidth = Math.max(2, Math.min(g.bandWidth - 2, g.bandWidth * 0.7, 40));
  return (
    <g>
      {buckets.map((bucket, i) => {
        const x = g.cx(i) - barWidth / 2;
        const present = series.filter((s) => bucket[s.key] > 0);
        let top = g.height;
        return (
          <g key={bucket.start}>
            {present.map((s, j) => {
              const h = g.height - g.y(bucket[s.key]);
              const y = top - h;
              // The gap comes out of the upper segment, so the stack's total
              // height stays true to the total count.
              const height = Math.max(0, h - (j === 0 ? 0 : GAP));
              top = y;
              return j === present.length - 1 ? (
                <path key={s.key} data-series={s.key} d={roundedTop(x, y, barWidth, height)} fill={s.color} />
              ) : (
                <rect key={s.key} data-series={s.key} x={x} y={y} width={barWidth} height={height} fill={s.color} />
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
```

Create `dashboard/src/components/charts/Lines.tsx`:

```tsx
import type { VolumeBucket } from "../../types";
import type { ChartGeometry } from "./ChartFrame";
import type { SeriesDef } from "./series";

export function Lines({
  g,
  buckets,
  series,
  hovered,
}: {
  g: ChartGeometry;
  buckets: VolumeBucket[];
  series: SeriesDef[];
  hovered: number | null;
}) {
  return (
    <g>
      {series.map((s) => (
        <path
          key={s.key}
          data-series={s.key}
          d={buckets.map((b, i) => `${i === 0 ? "M" : "L"}${g.cx(i)},${g.y(b[s.key])}`).join("")}
          fill="none"
          stroke={s.color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {hovered !== null && (
        <g>
          <line
            x1={g.cx(hovered)}
            x2={g.cx(hovered)}
            y1={0}
            y2={g.height}
            stroke="var(--color-muted)"
            strokeDasharray="3 3"
          />
          {series.map((s) => (
            <circle
              key={s.key}
              cx={g.cx(hovered)}
              cy={g.y(buckets[hovered][s.key])}
              r={4}
              fill={s.color}
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
          ))}
        </g>
      )}
    </g>
  );
}
```

- [ ] **Step 5: Implement the chart container**

Create `dashboard/src/components/charts/VolumeChart.tsx`:

```tsx
import { useLayoutEffect, useRef, useState } from "react";
import type { TimelineSummary, VolumeBucket } from "../../types";
import { Button, Segmented, Swatch } from "../ui";
import { ChartFrame, MARGIN, chartGeometry } from "./ChartFrame";
import { Lines } from "./Lines";
import { niceTicks } from "./scale";
import type { SeriesDef } from "./series";
import { StackedBars } from "./StackedBars";

type Mode = "bars" | "lines";
const MODE_KEY = "repro.chartMode";
const FALLBACK_WIDTH = 640;

// The chart type is a per-viewer convenience: storage may be blocked, and the
// chart must render either way.
function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "lines" ? "lines" : "bars";
  } catch {
    return "bars";
  }
}

function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (element.clientWidth > 0) setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function bucketLabel(start: string, unit: "hour" | "day"): string {
  const date = new Date(start);
  return unit === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function bucketTitle(start: string, unit: "hour" | "day"): string {
  const date = new Date(start);
  return unit === "hour"
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function total(bucket: VolumeBucket, series: SeriesDef[]): number {
  return series.reduce((sum, s) => sum + bucket[s.key], 0);
}

export function VolumeChart({ summary, series }: { summary: TimelineSummary; series: SeriesDef[] }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [showTable, setShowTable] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();
  const { buckets, bucket: unit } = summary;

  const peak = Math.max(
    0,
    ...buckets.map((b) => (mode === "bars" ? total(b, series) : Math.max(0, ...series.map((s) => b[s.key]))))
  );
  const ticks = niceTicks(peak);
  const g = chartGeometry(width, buckets.length, ticks[ticks.length - 1]);
  const hoveredBucket = hovered === null ? undefined : buckets[hovered];
  // Keep the tooltip inside the chart near either edge.
  const align =
    hovered === null || hovered < buckets.length / 5
      ? ""
      : hovered >= (buckets.length * 4) / 5
        ? "-translate-x-full"
        : "-translate-x-1/2";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ul aria-label="Legend" className="flex flex-wrap gap-4 text-sm text-muted">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <Swatch color={s.color} />
              {s.label}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Segmented
            label="Chart type"
            options={[
              ["bars", "Bars"],
              ["lines", "Lines"],
            ]}
            value={mode}
            onChange={(next) => {
              setMode(next);
              saveMode(next);
            }}
          />
          <Button variant="secondary" aria-pressed={showTable} onClick={() => setShowTable((shown) => !shown)}>
            {showTable ? "Show chart" : "Show table"}
          </Button>
        </div>
      </div>

      {/* Kept mounted while the table shows, so its width stays measured. */}
      <div ref={ref} className={showTable ? "hidden" : "relative"}>
        <ChartFrame
          width={width}
          geometry={g}
          ticks={ticks}
          labels={buckets.map((b) => bucketLabel(b.start, unit))}
          label={`Timelines per ${unit}`}
          onHover={setHovered}
        >
          {mode === "bars" ? (
            <StackedBars g={g} buckets={buckets} series={series} />
          ) : (
            <Lines g={g} buckets={buckets} series={series} hovered={hovered} />
          )}
        </ChartFrame>
        {hoveredBucket && hovered !== null && (
          <div
            role="tooltip"
            className={`pointer-events-none absolute top-0 z-10 min-w-40 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm ${align}`}
            style={{ left: MARGIN.left + g.cx(hovered) }}
          >
            <p className="mb-1 font-medium text-fg">{bucketTitle(hoveredBucket.start, unit)}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center gap-2 text-muted">
                <Swatch color={s.color} />
                <span>{s.label}</span>
                <span className="ml-auto pl-3 font-medium tabular-nums text-fg">{hoveredBucket[s.key]}</span>
              </p>
            ))}
            {series.length > 1 && (
              <p className="mt-1 flex border-t border-border pt-1 text-muted">
                <span>Total</span>
                <span className="ml-auto pl-3 font-medium tabular-nums text-fg">{total(hoveredBucket, series)}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {showTable && (
        <table className="w-full text-sm">
          <caption className="sr-only">Timelines per {unit}</caption>
          <thead>
            <tr className="text-left text-muted">
              <th className="py-2 font-medium">{unit === "hour" ? "Hour" : "Day"}</th>
              {series.map((s) => (
                <th key={s.key} className="text-right font-medium">
                  {s.label}
                </th>
              ))}
              <th className="text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.start} className="border-t border-border">
                <td className="py-1.5">{bucketTitle(b.start, unit)}</td>
                {series.map((s) => (
                  <td key={s.key} className="text-right tabular-nums">
                    {b[s.key]}
                  </td>
                ))}
                <td className="text-right tabular-nums">{total(b, series)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm test -w dashboard -- src/components/charts && npm run typecheck -w dashboard && npm run lint -w dashboard`
Expected: PASS, 12 tests.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/charts
git commit -m "feat(dashboard): hand-rolled volume chart: stacked bars, lines, tooltip, table view"
```

---

### Task 7: The Timelines tab

**Files:**
- Create: `dashboard/src/components/timelines/FilterBar.tsx`, `TagPicker.tsx`, `TopReasons.tsx`, `TimelineList.tsx`, `TagChips.tsx`, `EmptyState.tsx`, `dashboard/src/pages/timelines.test.tsx`
- Modify: `dashboard/src/pages/TimelinesPage.tsx` (replace the placeholder)

- [ ] **Step 1: Write the failing page tests**

Create `dashboard/src/pages/timelines.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type ApiCall, type MockHandler } from "../test/utils";
import type { Project, TimelineRow, TimelineSummary } from "../types";

const PROJECT: Project = { id: "proj-1", orgId: ORG_ID, name: "web", createdAt: "2026-09-01T00:00:00.000Z", activeKeyCount: 1 };
const PAGE = `/orgs/${ORG_ID}/projects/proj-1`;
const BASE = `/api/orgs/${ORG_ID}/projects/proj-1/timelines`;
const KEY = "a".repeat(32);

function row(id: string, overrides: Partial<TimelineRow> = {}): TimelineRow {
  return {
    id,
    receivedAt: new Date(Date.now() - 60_000).toISOString(),
    sessionId: "s1",
    reasonType: "error",
    reasonName: "TypeError",
    reasonMessage: `boom ${id}`,
    url: "https://shop.example.com/checkout",
    tags: ["checkout"],
    eventCount: 3,
    ...overrides,
  };
}

const SUMMARY: TimelineSummary = {
  projectHasTimelines: true,
  bucket: "day",
  buckets: [{ start: "2026-09-22T00:00:00.000Z", error: 2, unhandledrejection: 0, manual: 1 }],
  topReasons: [{ key: KEY, type: "error", name: "TypeError", message: "boom", count: 2, lastSeen: new Date().toISOString() }],
};

function handlers(extra: Record<string, MockHandler> = {}): Record<string, MockHandler> {
  return {
    "GET /api/me": { body: ME },
    [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } },
    [`GET ${BASE}`]: { body: { timelines: [row("t1"), row("t2")], nextCursor: null } },
    [`GET ${BASE}/summary`]: { body: SUMMARY },
    [`GET ${BASE}/tags`]: { body: { tags: [{ tag: "checkout", count: 2 }, { tag: "video_player", count: 1 }] } },
    ...extra,
  };
}

const location = () => screen.getByTestId("location");
const paths = (calls: ApiCall[]) => calls.map((c) => c.path);

describe("timelines tab", () => {
  it("shows the setup snippet while the project has no timelines", async () => {
    mockApi(handlers({ [`GET ${BASE}/summary`]: { body: { ...SUMMARY, projectHasTimelines: false, topReasons: [] } } }));
    renderApp(PAGE);

    expect(await screen.findByRole("heading", { name: "No timelines yet" })).toBeInTheDocument();
    expect(screen.getByText(/\/v1\/timeline/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Keys tab" })).toHaveAttribute("href", `${PAGE}/keys`);
  });

  it("shows the list, the chart and the top reasons", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    expect(await screen.findByRole("link", { name: /boom t1/ })).toHaveAttribute("href", `${PAGE}/timelines/t1`);
    expect(screen.getByRole("link", { name: /boom t2/ })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Timelines per day" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "TypeError: boom" })).toBeInTheDocument();
  });

  it("reads the filters from the URL and sends them to the API", async () => {
    const calls = mockApi(handlers());
    renderApp(`${PAGE}?range=30d&tag=checkout`);
    await screen.findByRole("link", { name: /boom t1/ });

    expect(paths(calls)).toContain(`${BASE}?range=30d&tag=checkout`);
    expect(paths(calls)).toContain(`${BASE}/tags?range=30d`);
    expect(paths(calls).some((p) => p.startsWith(`${BASE}/summary?range=30d&tag=checkout&tz=`))).toBe(true);
  });

  it("changes the range, reason types and tags through the URL", async () => {
    const calls = mockApi(handlers());
    const user = userEvent.setup();
    renderApp(PAGE);
    await screen.findByRole("link", { name: /boom t1/ });

    await user.click(within(screen.getByRole("group", { name: "Time range" })).getByRole("button", { name: "24h" }));
    await waitFor(() => expect(location()).toHaveTextContent("range=24h"));

    await user.click(within(screen.getByRole("group", { name: "Reason types" })).getByRole("button", { name: "Manual" }));
    await waitFor(() => expect(location()).toHaveTextContent("reasonType=manual"));

    await user.click(screen.getByText("Tags"));
    await user.click(screen.getByRole("checkbox", { name: /video_player/ }));
    await waitFor(() => expect(location()).toHaveTextContent("tag=video_player"));

    await waitFor(() => expect(paths(calls)).toContain(`${BASE}?range=24h&reasonType=manual&tag=video_player`));
  });

  it("filters by a top reason, and the chip clears it", async () => {
    const calls = mockApi(handlers());
    const user = userEvent.setup();
    renderApp(PAGE);

    await user.click(await screen.findByRole("button", { name: "TypeError: boom" }));
    await waitFor(() => expect(location()).toHaveTextContent(`reason=${KEY}`));
    await waitFor(() => expect(paths(calls)).toContain(`${BASE}?reason=${KEY}`));

    await user.click(screen.getByRole("button", { name: "Clear reason filter" }));
    await waitFor(() => expect(location()).not.toHaveTextContent("reason="));
  });

  it("loads the next page with the cursor", async () => {
    const calls = mockApi(
      handlers({
        [`GET ${BASE}`]: { body: { timelines: [row("t1")], nextCursor: "c1" } },
        [`GET ${BASE}?cursor=c1`]: { body: { timelines: [row("t2")], nextCursor: null } },
      })
    );
    const user = userEvent.setup();
    renderApp(PAGE);

    await user.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("link", { name: /boom t2/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /boom t1/ })).toBeInTheDocument();
    expect(paths(calls)).toContain(`${BASE}?cursor=c1`);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("says so when nothing matches the filters", async () => {
    mockApi(handlers({ [`GET ${BASE}`]: { body: { timelines: [], nextCursor: null } } }));
    renderApp(PAGE);
    expect(await screen.findByText("No timelines match these filters.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w dashboard -- src/pages/timelines.test.tsx`
Expected: FAIL. The placeholder page renders none of this.

- [ ] **Step 3: Implement the pieces**

Create `dashboard/src/components/timelines/TagChips.tsx`:

```tsx
import { Chip } from "../ui";

export function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Chip key={tag}>
          <span className="font-mono">{tag}</span>
        </Chip>
      ))}
    </span>
  );
}
```

Create `dashboard/src/components/timelines/TopReasons.tsx`:

```tsx
import { REASON_LABELS, formatDateTime, formatRelative } from "../../format";
import type { TopReason } from "../../types";
import { SERIES_COLORS } from "../charts/series";
import { Swatch } from "../ui";

export function reasonText(reason: { name: string | null; message: string | null }): string {
  return [reason.name, reason.message].filter(Boolean).join(": ") || "(no message)";
}

export function TopReasons({
  reasons,
  selected,
  onSelect,
}: {
  reasons: TopReason[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  if (reasons.length === 0) {
    return <p className="text-sm text-muted">Nothing in this range.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] table-fixed text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th className="w-44 py-2 font-medium">Type</th>
            <th className="font-medium">Reason</th>
            <th className="w-16 text-right font-medium">Count</th>
            <th className="w-32 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {reasons.map((reason) => (
            <tr key={reason.key} className={`border-t border-border ${reason.key === selected ? "bg-bg" : ""}`}>
              <td className="py-2">
                <span className="inline-flex items-center gap-2">
                  <Swatch color={SERIES_COLORS[reason.type]} />
                  {REASON_LABELS[reason.type]}
                </span>
              </td>
              <td>
                <button
                  type="button"
                  title={reasonText(reason)}
                  onClick={() => onSelect(reason.key)}
                  className="block w-full truncate text-left hover:underline"
                >
                  {reasonText(reason)}
                </button>
              </td>
              <td className="text-right tabular-nums">{reason.count}</td>
              <td className="text-right text-muted" title={formatDateTime(reason.lastSeen)}>
                {formatRelative(reason.lastSeen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Create `dashboard/src/components/timelines/TagPicker.tsx`:

```tsx
import type { TagCount } from "../../types";

export function TagPicker({
  tags,
  selected,
  onChange,
}: {
  tags: TagCount[];
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-border bg-surface px-3 py-1 text-sm">
        {selected.length > 0 ? `Tags (${selected.length})` : "Tags"}
      </summary>
      <div className="absolute z-10 mt-1 max-h-64 w-60 overflow-auto rounded-md border border-border bg-surface p-2 shadow-sm">
        {tags.length === 0 ? (
          <p className="px-1 text-sm text-muted">No tags in this range.</p>
        ) : (
          tags.map(({ tag, count }) => (
            <label key={tag} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-bg">
              <input
                type="checkbox"
                checked={selected.includes(tag)}
                onChange={(event) =>
                  onChange(event.target.checked ? [...selected, tag] : selected.filter((t) => t !== tag))
                }
              />
              <span className="font-mono">{tag}</span>
              <span className="ml-auto tabular-nums text-muted">{count}</span>
            </label>
          ))
        )}
      </div>
    </details>
  );
}
```

Create `dashboard/src/components/timelines/FilterBar.tsx`:

```tsx
import { REASON_LABELS } from "../../format";
import { RANGES, REASON_TYPES, type TimelineFilters } from "../../timelineFilters";
import type { ReasonType, TagCount, TopReason } from "../../types";
import { SERIES_COLORS } from "../charts/series";
import { Chip, Segmented, Swatch } from "../ui";
import { TagPicker } from "./TagPicker";
import { reasonText } from "./TopReasons";

export function FilterBar({
  filters,
  onChange,
  tags,
  selectedReason,
}: {
  filters: TimelineFilters;
  onChange: (changes: Partial<TimelineFilters>) => void;
  tags: TagCount[];
  /** The top reason matching filters.reason, if it's in the current top 10. */
  selectedReason: TopReason | undefined;
}) {
  const toggleType = (type: ReasonType) => {
    const next = filters.reasonTypes.includes(type)
      ? filters.reasonTypes.filter((t) => t !== type)
      : [...filters.reasonTypes, type];
    // All three is the same as none; keep one URL for it.
    onChange({ reasonTypes: next.length === REASON_TYPES.length ? [] : REASON_TYPES.filter((t) => next.includes(t)) });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Time range"
          options={RANGES.map((range) => [range, range] as const)}
          value={filters.range}
          onChange={(range) => onChange({ range })}
        />
        <div role="group" aria-label="Reason types" className="flex flex-wrap gap-1">
          {REASON_TYPES.map((type) => {
            const on = filters.reasonTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                aria-pressed={on}
                onClick={() => toggleType(type)}
                className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-sm ${on ? "border-fg/30 bg-surface font-medium text-fg" : "border-border text-muted hover:text-fg"}`}
              >
                <Swatch color={SERIES_COLORS[type]} />
                {REASON_LABELS[type]}
              </button>
            );
          })}
        </div>
        <TagPicker tags={tags} selected={filters.tags} onChange={(next) => onChange({ tags: next })} />
      </div>
      {(filters.reason || filters.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {filters.reason && (
            <Chip onRemove={() => onChange({ reason: null })} removeLabel="Clear reason filter">
              <span className="max-w-64 truncate">Reason: {selectedReason ? reasonText(selectedReason) : "selected"}</span>
            </Chip>
          )}
          {filters.tags.map((tag) => (
            <Chip
              key={tag}
              onRemove={() => onChange({ tags: filters.tags.filter((t) => t !== tag) })}
              removeLabel={`Remove tag ${tag}`}
            >
              <span className="font-mono">{tag}</span>
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
```

Create `dashboard/src/components/timelines/TimelineList.tsx`:

```tsx
import { Link } from "react-router";
import { REASON_LABELS, formatDateTime, formatRelative, urlPath } from "../../format";
import type { TimelineRow } from "../../types";
import { SERIES_COLORS } from "../charts/series";
import { Swatch } from "../ui";
import { TagChips } from "./TagChips";
import { reasonText } from "./TopReasons";

export function TimelineList({ orgId, projectId, timelines }: { orgId: string; projectId: string; timelines: TimelineRow[] }) {
  if (timelines.length === 0) {
    return <p className="text-sm text-muted">No timelines match these filters.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {timelines.map((t) => (
        <li key={t.id}>
          <Link
            to={`/orgs/${orgId}/projects/${projectId}/timelines/${t.id}`}
            className="grid gap-1 rounded-md px-2 py-3 hover:bg-bg sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-4"
          >
            <time dateTime={t.receivedAt} title={formatDateTime(t.receivedAt)} className="text-sm text-muted">
              {formatRelative(t.receivedAt)}
            </time>
            <span className="min-w-0 space-y-1">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <Swatch color={SERIES_COLORS[t.reasonType]} />
                <span className="shrink-0 text-muted">{REASON_LABELS[t.reasonType]}</span>
                <span className="truncate font-medium">{reasonText({ name: t.reasonName, message: t.reasonMessage })}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="truncate font-mono">{urlPath(t.url)}</span>
                <TagChips tags={t.tags} />
              </span>
            </span>
            <span className="text-xs tabular-nums text-muted">
              {t.eventCount} {t.eventCount === 1 ? "event" : "events"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

Create `dashboard/src/components/timelines/EmptyState.tsx`:

```tsx
import { Link } from "react-router";
import { Card, CopyButton } from "../ui";

export function EmptyState({ orgId, projectId }: { orgId: string; projectId: string }) {
  const snippet = [
    `import { init, setTags } from "@repro/js";`,
    "",
    "init({",
    `  endpoint: "${window.location.origin}/v1/timeline",`,
    `  apiKey: "<your API key>",`,
    "});",
    "",
    `setTags(["checkout"]); // optional: the area of your app`,
  ].join("\n");

  return (
    <Card className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-medium">No timelines yet</h2>
        <p className="text-sm text-muted">
          Add <code className="font-mono">@repro/js</code> to your app and initialize it with a key from the{" "}
          <Link to={`/orgs/${orgId}/projects/${projectId}/keys`} className="text-accent hover:underline">
            Keys tab
          </Link>
          . Timelines show up here as soon as the first one arrives.
        </p>
      </div>
      <pre className="overflow-x-auto rounded-md bg-bg p-3 font-mono text-sm">
        <code>{snippet}</code>
      </pre>
      <CopyButton value={snippet} />
    </Card>
  );
}
```

Replace `dashboard/src/pages/TimelinesPage.tsx`:

```tsx
import { useParams } from "react-router";
import { SERIES } from "../components/charts/series";
import { VolumeChart } from "../components/charts/VolumeChart";
import { EmptyState } from "../components/timelines/EmptyState";
import { FilterBar } from "../components/timelines/FilterBar";
import { TimelineList } from "../components/timelines/TimelineList";
import { TopReasons } from "../components/timelines/TopReasons";
import { Button, Card, ErrorText } from "../components/ui";
import { useTimelineSummary, useTimelineTags, useTimelines } from "../queries";
import { useTimelineFilters } from "../timelineFilters";

export function TimelinesPage() {
  const { orgId = "", projectId = "" } = useParams();
  const [filters, setFilters] = useTimelineFilters();
  const summary = useTimelineSummary(orgId, projectId, filters);
  const tags = useTimelineTags(orgId, projectId, filters.range);
  const list = useTimelines(orgId, projectId, filters);

  if (summary.data && !summary.data.projectHasTimelines) {
    return <EmptyState orgId={orgId} projectId={projectId} />;
  }

  // Colors follow the reason type, so hiding one never repaints the others.
  const series = SERIES.filter((s) => filters.reasonTypes.length === 0 || filters.reasonTypes.includes(s.key));
  const topReasons = summary.data?.topReasons ?? [];
  const timelines = list.data?.pages.flatMap((page) => page.timelines) ?? [];

  return (
    <div className="space-y-6">
      <FilterBar
        filters={filters}
        onChange={setFilters}
        tags={tags.data ?? []}
        selectedReason={topReasons.find((r) => r.key === filters.reason)}
      />

      <Card className="space-y-4">
        <h2 className="font-medium">Volume</h2>
        <ErrorText error={summary.error} />
        {summary.data && <VolumeChart summary={summary.data} series={series} />}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">Top reasons</h2>
        {summary.data && (
          <TopReasons reasons={topReasons} selected={filters.reason} onSelect={(reason) => setFilters({ reason })} />
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">Timelines</h2>
        <ErrorText error={list.error} />
        {list.data && <TimelineList orgId={orgId} projectId={projectId} timelines={timelines} />}
        {list.hasNextPage && (
          <Button variant="secondary" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w dashboard && npm run typecheck -w dashboard && npm run lint -w dashboard`
Expected: PASS, including the Task 5 project-tab tests, which now render the real Timelines tab with their empty-summary handlers.

The tag test clicks the `<summary>` before the checkbox. If this jsdom version doesn't toggle `<details>` on a summary click, the checkbox is still clickable, because user-event only checks `pointer-events`. So the test doesn't depend on that.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src
git commit -m "feat(dashboard): timelines tab: filters, volume chart, top reasons, list, empty state"
```

---

### Task 8: Timeline detail page

**Files:**
- Create: `dashboard/src/pages/TimelinePage.tsx`, `dashboard/src/pages/timeline.test.tsx`
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Write the failing tests**

Create `dashboard/src/pages/timeline.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";
import type { TimelineDetail } from "../types";

const PAGE = `/orgs/${ORG_ID}/projects/proj-1/timelines/t1`;
const API = `/api/orgs/${ORG_ID}/projects/proj-1/timelines/t1`;
const CAPTURED_AT = 1_790_000_000_000;

const DETAIL: TimelineDetail = {
  timeline: {
    id: "t1",
    receivedAt: "2026-09-22T10:00:00.000000Z",
    sessionId: "s1",
    tags: ["checkout"],
    reason: { type: "error", name: "TypeError", message: "Cannot read properties of undefined", data: { orderId: 7 } },
    events: [
      { timestamp: CAPTURED_AT - 12_400, type: "trace", name: "Pay button" },
      { timestamp: CAPTURED_AT - 2_000, type: "custom", name: "checkout.step", data: { step: "payment" } },
    ],
    meta: { url: "https://shop.example.com/checkout", userAgent: "Mozilla/5.0 test", capturedAt: CAPTURED_AT },
  },
  siblings: [{ id: "t0", receivedAt: "2026-09-22T09:59:00.000000Z", reasonType: "manual", reasonName: "payment-declined" }],
};

function handlers(detail: MockHandler = { body: DETAIL }): Record<string, MockHandler> {
  return { "GET /api/me": { body: ME }, [`GET ${API}`]: detail };
}

describe("timeline detail", () => {
  it("shows the reason, tags and events timed from the capture", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    expect(await screen.findByRole("heading", { name: "TypeError" })).toBeInTheDocument();
    expect(screen.getByText("Cannot read properties of undefined")).toBeInTheDocument();
    expect(screen.getByText("checkout")).toBeInTheDocument();

    const events = within(screen.getByRole("list", { name: "Events" }));
    expect(events.getByText("−12.4s")).toBeInTheDocument();
    expect(events.getByText("Pay button")).toBeInTheDocument();
    expect(events.getByText("−2.0s")).toBeInTheDocument();
    expect(events.getByText("0.0s")).toBeInTheDocument();
  });

  it("keeps event data collapsed until opened", async () => {
    mockApi(handlers());
    renderApp(PAGE);

    const data = await screen.findByText(/"step": "payment"/);
    expect(data).not.toBeVisible();
    expect(data.closest("details")).not.toHaveAttribute("open");
  });

  it("links the captured URL only when it's http(s)", async () => {
    mockApi(handlers());
    renderApp(PAGE);
    expect(await screen.findByRole("link", { name: "https://shop.example.com/checkout" })).toHaveAttribute(
      "href",
      "https://shop.example.com/checkout"
    );
  });

  it("never links a javascript: URL", async () => {
    const hostile = { ...DETAIL, timeline: { ...DETAIL.timeline, meta: { ...DETAIL.timeline.meta, url: "javascript:alert(1)" } } };
    mockApi(handlers({ body: hostile }));
    renderApp(PAGE);

    expect(await screen.findByText("javascript:alert(1)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "javascript:alert(1)" })).not.toBeInTheDocument();
  });

  it("links the other timelines from the same session", async () => {
    mockApi(handlers());
    renderApp(PAGE);
    expect(await screen.findByRole("link", { name: /payment-declined/ })).toHaveAttribute(
      "href",
      `/orgs/${ORG_ID}/projects/proj-1/timelines/t0`
    );
  });

  it("says so when the timeline doesn't exist", async () => {
    mockApi(handlers({ status: 404, body: { error: "Not Found" } }));
    renderApp(PAGE);
    expect(await screen.findByRole("heading", { name: "Timeline not found" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w dashboard -- src/pages/timeline.test.tsx`
Expected: FAIL. The route doesn't exist, so the page renders the not-found page.

- [ ] **Step 3: Implement the page and route**

Create `dashboard/src/pages/TimelinePage.tsx`:

```tsx
import { Link, useParams } from "react-router";
import { ApiError } from "../api";
import { SERIES_COLORS } from "../components/charts/series";
import { TagChips } from "../components/timelines/TagChips";
import { Card, ErrorText, Swatch } from "../components/ui";
import { REASON_LABELS, formatDateTime, formatOffset, formatRelative, safeHref } from "../format";
import { useTimeline } from "../queries";
import type { TimelineEvent } from "../types";

const EVENT_LABELS: Record<TimelineEvent["type"], string> = {
  custom: "Track",
  trace: "Click",
  error: "Error",
  unhandledrejection: "Unhandled rejection",
};

function DataBlock({ data }: { data: Record<string, unknown> | undefined }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">Data</summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-bg p-2 font-mono text-xs">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

// capturedAt comes from the browser; a nonsense value must not crash the page.
function formatEpoch(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

// Everything shown here comes from the captured payload: it's rendered as text,
// and the URL becomes a link only when it's http(s).
export function TimelinePage() {
  const { orgId = "", projectId = "", timelineId = "" } = useParams();
  const query = useTimeline(orgId, projectId, timelineId);
  const back = `/orgs/${orgId}/projects/${projectId}`;
  const backLink = (
    <Link to={back} className="text-sm text-muted hover:text-fg">
      ← Timelines
    </Link>
  );

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <Card className="space-y-2">
        <h1 className="text-lg font-semibold">Timeline not found</h1>
        <p className="text-sm text-muted">It doesn't exist, or it has passed the retention period.</p>
        {backLink}
      </Card>
    );
  }
  if (!query.data) {
    return (
      <div className="space-y-4">
        {backLink}
        <ErrorText error={query.error} />
      </div>
    );
  }

  const { timeline, siblings } = query.data;
  const { reason, meta } = timeline;
  const href = safeHref(meta.url);

  return (
    <div className="space-y-6">
      {backLink}
      <header className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Swatch color={SERIES_COLORS[reason.type]} />
          <span>{REASON_LABELS[reason.type]}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={timeline.receivedAt} title={formatDateTime(timeline.receivedAt)}>
            {formatRelative(timeline.receivedAt)}
          </time>
        </p>
        <h1 className="break-words text-xl font-semibold">{reason.name ?? REASON_LABELS[reason.type]}</h1>
        {reason.message && <p className="whitespace-pre-wrap break-words font-mono text-sm">{reason.message}</p>}
        <TagChips tags={timeline.tags} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="space-y-4">
          <h2 className="font-medium">Events</h2>
          {timeline.events.length === 0 && (
            <p className="text-sm text-muted">No breadcrumbs were recorded before this capture.</p>
          )}
          <ol aria-label="Events" className="space-y-3">
            {timeline.events.map((event, i) => (
              <li key={i} className="border-l border-border pl-3 text-sm">
                <p className="flex flex-wrap items-baseline gap-x-3">
                  <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted">
                    {formatOffset(event.timestamp - meta.capturedAt)}
                  </span>
                  <span className="text-xs text-muted">{EVENT_LABELS[event.type]}</span>
                  <span className="break-words font-medium">{event.name}</span>
                </p>
                <DataBlock data={event.data} />
              </li>
            ))}
            <li aria-current="step" className="rounded-md border-l-2 border-accent bg-accent/5 py-1 pl-3 text-sm">
              <p className="flex flex-wrap items-baseline gap-x-3">
                <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-muted">{formatOffset(0)}</span>
                <span className="text-xs text-muted">Captured</span>
                <span className="break-words font-medium">
                  {[reason.name, reason.message].filter(Boolean).join(": ") || REASON_LABELS[reason.type]}
                </span>
              </p>
              <DataBlock data={reason.data} />
            </li>
          </ol>
        </Card>

        <aside className="space-y-6">
          <Card className="space-y-3">
            <h2 className="font-medium">Details</h2>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-muted">URL</dt>
                <dd className="break-all">
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                      {meta.url}
                    </a>
                  ) : (
                    meta.url
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">User agent</dt>
                <dd className="break-words">{meta.userAgent}</dd>
              </div>
              <div>
                <dt className="text-muted">Captured at</dt>
                <dd>{formatEpoch(meta.capturedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted">Session</dt>
                <dd className="break-all font-mono text-xs">{timeline.sessionId}</dd>
              </div>
            </dl>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-medium">Same session</h2>
            {siblings.length === 0 ? (
              <p className="text-sm text-muted">No other timelines from this session.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {siblings.map((sibling) => (
                  <li key={sibling.id}>
                    <Link to={`${back}/timelines/${sibling.id}`} className="flex items-center gap-2 hover:underline">
                      <Swatch color={SERIES_COLORS[sibling.reasonType]} />
                      <span className="min-w-0 flex-1 truncate">{sibling.reasonName ?? REASON_LABELS[sibling.reasonType]}</span>
                      <time dateTime={sibling.receivedAt} className="shrink-0 text-xs text-muted">
                        {formatRelative(sibling.receivedAt)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
```

In `dashboard/src/App.tsx`, import `TimelinePage` and add its route next to the project route, inside `OrgLayout`:

```tsx
import { TimelinePage } from "./pages/TimelinePage";
```

```tsx
            <Route path="projects/:projectId/timelines/:timelineId" element={<TimelinePage />} />
```

React Router ranks this route above `projects/:projectId`, because more of its segments match.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w dashboard && npm run typecheck -w dashboard && npm run lint -w dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src
git commit -m "feat(dashboard): timeline detail with events, details and same-session links"
```

---

### Task 9: Docs, whole-repo verification, docker-compose smoke test

**Files:**
- Modify: `server/README.md`, `docs/superpowers/specs/2026-09-22-repro-client-library-design.md`, `docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md`

- [ ] **Step 1: Update the docs**

In `server/README.md`, in "## API", after the `/api/*` paragraph, add:

```markdown
The timeline viewer reads through `GET /api/orgs/:orgId/projects/:projectId/timelines`
(filtered, keyset-paginated list), `…/timelines/summary` (volume buckets and top
reasons), `…/timelines/tags` and `…/timelines/:timelineId`. Any member of the org
can call them. See `docs/superpowers/specs/2026-09-23-repro-dashboard-timelines-design.md`.
```

In the `POST /v1/timeline` paragraph of the same section, add a sentence: "It accepts an optional `tags` array (at most 10 tags, each matching `^[a-z0-9][a-z0-9_.:-]{0,49}$`)."

In `docs/superpowers/specs/2026-09-22-repro-client-library-design.md`, add at the end of "## Data model":

```markdown
> Extended by `2026-09-23-repro-dashboard-timelines-design.md`: payloads gain an
> optional top-level `tags` array, set with `setTags()` / `capture(…, { tags })`
> (see that spec's "Tags" section).
```

In `docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md`, add at the end of "### `POST /v1/timeline`":

```markdown
> Extended by `2026-09-23-repro-dashboard-timelines-design.md`: the body accepts an
> optional `tags` array, stored in `timelines.tags` (`text[]`, GIN-indexed).
```

- [ ] **Step 2: Verify the whole repo**

Run from the repo root:

```bash
npm run build && npm run typecheck && npm run lint && npm test
```

Expected: every workspace builds, typechecks, lints and passes. Record the test counts per workspace in the task report.

- [ ] **Step 3: Commit the docs**

```bash
git add server/README.md docs/superpowers/specs/2026-09-22-repro-client-library-design.md docs/superpowers/specs/2026-09-22-repro-ingest-api-design.md
git commit -m "docs: document tags and the timeline read API"
```

- [ ] **Step 4: Docker smoke test (with the user)**

This step needs a browser. Build and start:

```bash
docker compose down -v && docker compose up -d --build
curl -s http://localhost:3000/health
```

Expected: `{"status":"ok"}`.

Write `smoke.html` into the scratchpad directory. It isn't committed. Serve it next to the built client with `npx --yes http-server <dir> -p 5500`, where `<dir>` holds `smoke.html` and a copy of `packages/js/dist/`:

```html
<!doctype html>
<button data-trace="Pay button">Pay</button>
<button id="boom">Throw</button>
<script type="module">
  import { init, setTags, capture } from "./dist/index.js";
  init({ endpoint: "http://localhost:3000/v1/timeline", apiKey: new URLSearchParams(location.search).get("key") });
  setTags(["checkout"]);
  document.getElementById("boom").onclick = () => { throw new Error("Cannot read properties of undefined"); };
  window.manual = () => capture("payment-declined", { code: "insufficient_funds" }, { tags: ["payments"] });
</script>
```

Then ask the user to walk through these steps and report the result of each:

1. Sign up, create a project, and copy its key. Before any timeline exists, the project opens on the Timelines tab and shows the setup snippet.
2. Open `http://localhost:5500/smoke.html?key=<key>`. Click **Pay**, then **Throw**, then run `manual()` in the console. That sends two timelines from one session: an auto-captured error tagged `checkout`, and a manual one tagged `checkout` and `payments`.
3. Send one untagged timeline and one with a hostile URL with `curl`: `curl -s -X POST http://localhost:3000/v1/timeline -H 'Content-Type: application/json' -H 'X-Repro-Key: <key>' -d '{"sessionId":"s2","reason":{"type":"error","message":"x"},"events":[],"meta":{"url":"javascript:alert(1)","userAgent":"curl","capturedAt":1}}'`.
4. Reload the Timelines tab. The chart shows today's bar stacked by type. **Lines** switches the chart, and the choice survives a reload. **Show table** shows the same counts.
5. Filter by the `payments` tag: only the manual timeline remains, and the URL has `tag=payments`. Click a top reason: the list narrows to it, and the chip clears it.
6. Open the error timeline. "Pay button" appears with a negative offset, the Same session sidebar links to the manual timeline, and the link works.
7. Open the curl timeline. `javascript:alert(1)` shows as plain text, not a link.
8. Switch the OS to dark mode. The chart colors, the grid and the tooltip all stay readable.

When the user confirms, the plan is done. Tear down with `docker compose down -v`.
