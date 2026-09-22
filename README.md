# repro

**Opt-in, developer-instrumented breadcrumb timeline for frontend bug reproduction.**

Most error-tracking tools give you a stack trace and not much else. Session-replay tools
give you everything — a full recording of the page — which is heavy, hard to keep
private, and mostly noise. `repro` takes a third approach: you explicitly mark the
moments in your own code that matter (`track("checkout.step", { step: "shipping" })`, or
declaratively via `data-trace="Sign up submit"` on an element). Nothing is captured
unless you say so. When something goes wrong — an uncaught error, or a manual
`capture()` call — the recent timeline of those moments is sent to a server, giving
engineers a rough reconstruction of what the user actually did leading up to the bug.

Low noise, small payloads, and much easier to keep anonymized than a tool that records
everything by default — because you control exactly what goes into every event.

## Status

This project is early and the idea itself is still being validated. Here's what
actually exists right now versus what's planned:

**Built, tested, working:**
- `@repro/js` — the browser client library. Framework-agnostic core, a browser adapter
  (DOM error hooks, `data-trace` click capture, `sessionStorage`-backed persistence,
  `fetch`-based delivery), and a thin React `ErrorBoundary` adapter.
- Full test suite (50 tests), TypeScript types, dual ESM/CJS build.

**Not built yet:**
- A backend to actually receive and store what the client sends (`endpoint`/`apiKey`
  in the config below currently point at nothing — you need to run your own stub
  server, or just use the console, to try this out today).
- A dashboard for viewing captured timelines.
- Self-host Docker packaging.
- A hosted SaaS option.
- An SSR/Node adapter (e.g. tracing Next.js's `getServerSideProps`) — the client
  library has two small hooks (`sessionId`, `seedEvents`) reserved for this, but the
  adapter itself doesn't exist yet.
- Publishing to npm — this package is not on the registry yet. To use it today, clone
  this repo and build it locally (see [Development](#development)), or install directly
  from the GitHub repo.

The full design rationale — why breadcrumbs instead of session replay, why
`sessionStorage` over `localStorage`, why `fetch({ keepalive: true })` over
`sendBeacon`, and everything else — is written up in
[`docs/superpowers/specs/2026-09-22-repro-client-library-design.md`](docs/superpowers/specs/2026-09-22-repro-client-library-design.md).

## Quick start

```ts
import { init, track, capture } from "@repro/js";

init({
  endpoint: "https://your-ingest-server.example.com/timeline", // you have to run this yourself for now
  apiKey: "your-api-key",
});

// Explicit breadcrumbs
track("checkout.step", { step: "shipping" });

// Manual "something is wrong" trigger — also fires automatically on
// uncaught errors and unhandled promise rejections
capture("payment-declined", { code: "insufficient_funds" });
```

Or mark elements declaratively instead of writing a handler:

```html
<button data-trace="Sign up form submit">Sign up</button>
```

React error boundary, if you want captures wired into your component tree too:

```tsx
import { ErrorBoundary } from "@repro/js/react";

<ErrorBoundary fallback={<p>Something broke.</p>}>
  <App />
</ErrorBoundary>;
```

## Development

```bash
npm install
npm test        # full suite (also rebuilds dist/ first)
npm run build    # tsup — ESM + CJS + .d.ts
npm run lint     # ESLint, including the core/browser boundary rule
npm run typecheck
```

`src/core/` is environment-agnostic (no `window`/`document`/browser globals — enforced
by an ESLint rule, not just convention). `src/browser/` is the DOM adapter and the
package's default entry point. `src/react/` is optional sugar.

## License

MIT — see [`LICENSE`](LICENSE).
