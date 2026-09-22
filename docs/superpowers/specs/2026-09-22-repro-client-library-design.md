# repro — client library design

Status: approved (client library only)
Date: 2026-09-22
Scope: the browser client library (`@repro/js`) only. Backend/ingest API, dashboard,
self-host packaging, hosted SaaS, and a future SSR/Node adapter are each their own
sub-project with their own future spec.

## Problem & concept

Existing tools (Sentry, LogRocket, Highlight.io, etc.) capture bugs either as bare stack
traces with no context, or as full session replay (DOM/video recording of everything the
user did) — heavy, privacy-invasive, and noisy.

`repro` takes a third approach: an **opt-in, developer-instrumented breadcrumb timeline**.
Developers explicitly mark meaningful moments in their own code (`track(name, data)`) or
declaratively on elements (`data-trace="..."`). Nothing is captured unless explicitly
marked. When an error occurs (auto-detected or manually flagged), the recent timeline of
these breadcrumbs is sent to a server, giving engineers a rough reconstruction of *what the
user actually did* leading up to the bug — not a full replay, but enough context to
understand and reproduce it. Low noise, small payload, and much easier to keep anonymized
than a tool that captures everything by default, because the developer controls exactly
what goes into every event.

This is a **YAGNI-first project**: the idea itself isn't validated yet, so this spec covers
only the client library — the actual novel piece — kept as small as it can be while still
being genuinely useful and extensible toward the pieces that come later (SSR correlation,
a real backend).

## Naming

Package: **`@repro/js`** (scoped, single package with subpath exports — see below). "repro"
was chosen over `trails`/`blackbox`/other candidates because it names the actual value prop
(getting repro steps for a bug) directly, and scoping under `@repro/*` sidesteps the fact
that almost every short, memorable bare word is already squatted on npm.

## Architecture & package shape

Single npm package, not a monorepo of separate packages — appropriate for a solo-maintained,
pre-validation project where the overhead of independent versioning/publishing across
packages isn't yet worth it. The core/adapter boundary is still real, just enforced by
subpath exports + a lint rule instead of npm package boundaries:

```
src/
  core/       # environment-agnostic: buffer, payload shaping, createTracer, flush logic
  browser/    # DOM adapter: window/document hooks, sessionStorage, fetch transport
  react/      # optional: ErrorBoundary, exported via "@repro/js/react"
```

- `core/` never imports `window`, `document`, or any browser-only API — enforced by an
  ESLint no-restricted-paths rule blocking `core/` → `browser/` imports. This is what
  keeps a future Node/SSR adapter (out of scope here) able to reuse `core/` unmodified.
- `browser/` is the default entry point (`@repro/js`) — what most consumers install.
- `react/` is thin sugar (an `ErrorBoundary` that calls `capture()` on catch), not
  load-bearing.
- Tree-shaking is provided by the package's `exports` map + `"sideEffects": false`, not by
  package boundaries.
- If the project outgrows this later (independent versioning becomes valuable), splitting
  into separate `@repro/core` / `@repro/browser` / `@repro/react` packages is a mechanical,
  low-risk move — reversing that (merging split packages back) would be much more painful,
  which is why single-package is the safer starting point.

### Core API shape

`createTracer(config)` is the real core, returning `{ track, capture, dispose }`. The
package also exports a lazily-initialized default instance so the common case needs no
ceremony:

```ts
import { init, track, capture } from "@repro/js";

init({
  endpoint: "https://ingest.example.com/timeline",
  apiKey: "...",
  maxEvents: 50,               // ring buffer size, default 50
  sessionId: "...",            // optional — e.g. supplied by a future SSR adapter
  seedEvents: [...],           // optional — e.g. server-captured events to prepend
  captureErrors: true,         // auto-hook window.onerror / unhandledrejection (default true)
  captureTraceAttribute: true, // auto-hook data-trace clicks (default true)
});

track("checkout.step", { step: "shipping" });          // manual breadcrumb -> type: "custom"
capture("payment-declined", { code: "insufficient_funds" }); // manual flush -> type: "manual"
```

- `track()`/`capture()` called before `init()` are a no-op with a console warning — never
  throws in a production code path.
- `init()` returns (or the default export exposes) a `dispose()` that removes all listeners
  — needed for clean teardown in tests and to avoid duplicate listeners across dev
  hot-reloads.
- Calling `init()` a second time replaces the default instance's config (with a dev
  warning) rather than silently stacking a second set of listeners.
- `createTracer(config)` is available directly for advanced/multi-instance use (testing,
  multiple independent trackers on one page).

### Forward-compatibility hooks for SSR (not built now)

Two cheap additions to the config keep a future server/SSR adapter (e.g. tracing Next.js's
`getServerSideProps`) possible without a rearchitecture, without building anything
server-side now:

- `sessionId` can be **supplied**, not just generated — a server-side adapter could mint the
  session ID and thread it through so server- and client-side breadcrumbs share one
  timeline.
- `seedEvents` lets the buffer be **pre-populated at init** — a server adapter could
  serialize its own captured events into the page (e.g. via `__NEXT_DATA__`) and the client
  library prepends them to its ring buffer.

Everything else about SSR/Node tracing (its own capture mechanism, its own package) is a
future sub-project.

## Data model

```ts
interface TimelineEvent {
  timestamp: number;               // Date.now()
  type: "custom" | "error" | "unhandledrejection" | "trace";
  name: string;                    // developer-chosen label, or the error message, or the data-trace value
  data?: Record<string, unknown>;  // developer-supplied payload; library never inspects/validates contents
}

interface TimelinePayload {
  sessionId: string;
  reason: {
    type: "error" | "unhandledrejection" | "manual";
    message?: string;              // e.g. error.message, only when an auto-hook fired
    name?: string;                 // developer-supplied label, only for manual capture()
  };
  events: TimelineEvent[];         // buffer contents at flush time, oldest first
  meta: {
    url: string;                   // location.href at flush time
    userAgent: string;
    capturedAt: number;
  };
}
```

`data` is intentionally untyped and unvalidated — consistent with anonymization being the
developer's responsibility (see below). `meta` is deliberately minimal: no IP capture, no
fingerprinting, keeping the "anonymized by design" claim true at the type level, not just in
docs.

## Declarative capture: `data-trace`

Elements can opt into capture declaratively instead of requiring a manual `track()` call in
an event handler:

```html
<button data-trace="Sign up form submit">Sign up</button>
```

- `data-*` (not a bare custom attribute) — reserved HTML namespace for custom data, passes
  validators/a11y linters cleanly, and is the convention every framework already expects.
- Implemented as a single delegated, capture-phase `click` listener on `document`
  (`event.target.closest('[data-trace]')`) — not a per-element listener, no
  `MutationObserver` needed, works automatically for elements added dynamically later.
- Pushes a `TimelineEvent` with `type: "trace"`, `name` = the attribute's value.
- On by default, opt-out via `captureTraceAttribute: false`.
- Caveat (not a library limitation): for a custom component like `<Button data-trace="...">`
  to work, that component must spread unrecognized props down onto its underlying DOM node.
  Native elements always just work.

## Buffer & persistence

- **In-memory array is the source of truth** at runtime. `sessionStorage` (not
  `localStorage`) is a best-effort persistence layer synced on every `track()`/`capture()`.
  - `sessionStorage`, not `localStorage`: it already survives full page reloads and SPA
    navigation within a tab (persists until the tab closes), which is the actual property
    we need — and unlike `localStorage`, it's tab-scoped, so two tabs of the same app don't
    clobber each other's timeline. This also matches the session ID (see below), which is
    tab-scoped for the same reason.
  - On `init()`, the library rehydrates from any existing persisted buffer (e.g. after a
    reload) before continuing to append.
  - All storage writes are wrapped in try/catch; if `sessionStorage` is unavailable
    (private browsing, quota exceeded, disabled), the library silently continues
    functioning in-memory only. Persistence is best-effort, never a requirement.
- **Ring buffer**: append, then trim to `maxEvents` (default 50, configurable), dropping
  the oldest. Write volume stays low because events only originate from explicit `track()`
  calls and `data-trace` clicks — no high-frequency auto-capture — so no batching/debouncing
  is needed for v1.

## Session ID

A random opaque UUID, generated per tab and stored in `sessionStorage` (regenerated on a
new tab/visit). Groups breadcrumbs into one continuous session for the (future) dashboard
without identifying the real user — no PII by default. Can be overridden via `init({
sessionId })` for the SSR-correlation case described above.

## Transport & delivery

- Every flush is delivered via `fetch(endpoint, { method: "POST", keepalive: true, headers:
  { "Content-Type": "application/json", "X-Repro-Key": apiKey }, body: JSON.stringify(payload)
  })`.
  - `keepalive: true` lets the request survive page unload/navigation — the case that
    actually matters here, since a flush is often triggered by the same event that's about
    to navigate the user away. `navigator.sendBeacon` was considered and rejected: it can't
    set custom headers (breaking the `apiKey` header) and shares a single ~64KB queue across
    *every* `sendBeacon` call on the page, not just ours.
  - No general `headers` config — the server's request shape is entirely ours to define, so
    the only thing a consumer needs to configure is `apiKey`, sent as a fixed header.
- Fire-and-forget: no retry queue, no backoff. A failed flush (backend down, network
  offline) is dropped with a `console.warn` in dev. Persisting/retrying failed sends is real
  complexity for a case that's rare enough not to justify it pre-validation; revisit if it
  turns out to matter in practice.
- `keepalive` requests have a practical size ceiling (~64KB in Chrome) — comfortably enough
  for a default 50-event buffer of small payloads, documented as a known constraint rather
  than solved for arbitrarily large `data` payloads.

## Anonymization guardrails

Matches the core positioning: the library never claims to guarantee anonymization — it
makes it hard to *accidentally* leak something obvious, while leaving full control (and
responsibility) with the developer, since events are structured/opt-in rather than raw DOM
capture.

- `redact(value)` exported as an opt-in helper for masking values before they're passed to
  `track()`/`capture()`.
- A dev-time nudge: `track()`/`capture()` scans a `data` object's **top-level keys only**
  (cheap, no deep traversal) against a small known-risky list (`password`, `token`,
  `secret`, `apiKey`, `ssn`, `creditCard`, ...) and `console.warn`s if one matches. It never
  blocks or strips the value — just flags it. Always on; the check is cheap enough not to
  need a prod/dev split.

## Environment safety

- Every browser-specific call (`window`, `document`, `sessionStorage`, `fetch`) is guarded
  so importing `@repro/js` in a non-browser context (e.g. accidentally in a Next.js server
  file) no-ops instead of throwing.
- Auto-hooked `window.onerror`/`unhandledrejection` handlers observe and flush, then let the
  error continue propagating normally — never `preventDefault()` or swallow it. The library
  must be safe to run alongside Sentry or similar tools.

## Tooling

- TypeScript, built with `tsup` (ESM + CJS + `.d.ts`, minimal config).
- Vitest: `jsdom` environment for browser-adapter tests (DOM hooks, sessionStorage, click
  delegation), plain Node environment for core tests (buffer logic, payload shaping) — this
  split enforces the core/browser boundary in the test suite, not just by convention.
- ESLint `no-restricted-paths` (or equivalent) blocking `core/` → `browser/` imports.

## Explicitly out of scope (future sub-projects)

- Backend ingest API + dashboard.
- Self-host Docker packaging.
- Hosted SaaS.
- SSR/Node adapter (e.g. Next.js `getServerSideProps` tracing) — the `sessionId` and
  `seedEvents` hooks above exist specifically to keep this possible later without
  rearchitecting the client library.
- Retry/backoff for failed flushes.
- Auto-scrubbing of PII (deliberately rejected in favor of developer-controlled guardrails).
