# Tripcord

**Mark the moments that matter in your app. When one happens, Tripcord sends you the path that led there.**

This is the browser client for [Tripcord](https://github.com/jonaszbigda/tripcord).
You mark the steps worth recording in your own code
(`track("checkout.step", { step: "shipping" })`, or `data-trace="Sign up submit"` on
an element). Nothing is recorded unless you say so. The client keeps the recent
steps in the tab and sends nothing until a moment you care about happens:

- **Something breaks.** Uncaught errors and unhandled rejections are captured
  automatically, so you see what the user did before the bug.
- **Something you want to understand happens.** Call `capture("signup.completed")`
  at a checkout, a signup or an abandoned form, and see the path users took to get
  there, and how often it happens.

No noise, only signal: small payloads, and much easier to keep anonymized than a
tool that records everything by default, because you write every event.

## Status

This project is early and the idea itself is still being validated. Here's what
exists right now versus what's planned:

**Built, tested, working:**
- `@tripcord/js` — this browser client library. Framework-agnostic core, a browser
  adapter (DOM error hooks, `data-trace` click capture, `sessionStorage`-backed
  persistence, `fetch`-based delivery), and a thin React `ErrorBoundary` adapter.
  TypeScript types, dual ESM/CJS build.
- A self-hostable server: the ingest API that receives timelines, and a dashboard
  for browsing them, filtering by tag and managing projects and API keys. It ships as
  a Docker image for amd64 and arm64.

**Not built yet:**
- A hosted SaaS option. For now you run your own server.
- An SSR/Node adapter (e.g. tracing Next.js's `getServerSideProps`) — the client
  library has two small hooks (`sessionId`, `seedEvents`) reserved for this, but the
  adapter itself doesn't exist yet.

The full design rationale — why breadcrumbs instead of session replay, why
`sessionStorage` over `localStorage`, why `fetch({ keepalive: true })` over
`sendBeacon`, and everything else — is written up in the
[client library design spec](https://github.com/jonaszbigda/tripcord/blob/main/docs/superpowers/specs/2026-09-22-repro-client-library-design.md).

## Install

```bash
npm i @tripcord/js
```

You need a Tripcord server to send timelines to. See
[Self-hosting](https://github.com/jonaszbigda/tripcord/blob/main/docs/self-hosting.md).

## Quick start

```ts
import { init, track, capture } from "@tripcord/js";

init({
  endpoint: "https://tripcord.example.com/v1/timeline", // your server's PUBLIC_URL + /v1/timeline
  apiKey: "your-api-key", // from the project's Keys tab in the dashboard
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
import { ErrorBoundary } from "@tripcord/js/react";

<ErrorBoundary fallback={<p>Something broke.</p>}>
  <App />
</ErrorBoundary>;
```

### Tags

Tags say where in your app a timeline came from, so you can filter by area in the
dashboard. Set the active area once, and every timeline captured after that
carries it. That includes uncaught errors, which have no call site of their own:

```ts
import { setTags, clearTags, capture } from "@tripcord/js";

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

### Page URLs

Each timeline records the page it came from. By default that's the origin and
path only (`https://shop.example.com/checkout`). The query string and `#fragment`
are dropped, because they often carry tokens, emails or session ids. To keep
something you know is safe, pass `sanitizeUrl`:

```ts
init({
  endpoint: "…",
  apiKey: "…",
  // Keep ?step=, drop everything else.
  sanitizeUrl: (url) => {
    const step = url.searchParams.get("step");
    return `${url.origin}${url.pathname}${step ? `?step=${encodeURIComponent(step)}` : ""}`;
  },
});
```

If `sanitizeUrl` throws or doesn't return a string, the default is used and a
warning is logged.

### Server compatibility

The client and the server are versioned independently. This table says which
server version each client feature needs:

| @tripcord/js | Needs server |
| --- | --- |
| 0.2.x, with tags | 0.1.0 or later |
| 0.2.x, without tags | any |

The server always accepts older clients' payloads: the ingest schema only ever
gains optional fields.

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

MIT — see [`LICENSE`](https://github.com/jonaszbigda/tripcord/blob/main/LICENSE).
