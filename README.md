# Tripcord

**Tripcord stays quiet until something breaks. Then it sends you the steps that led there.**

[![CI](https://github.com/jonaszbigda/tripcord/actions/workflows/ci.yml/badge.svg)](https://github.com/jonaszbigda/tripcord/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tripcord/js)](https://www.npmjs.com/package/@tripcord/js)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Tripcord is a self-hosted tool for reproducing frontend bugs. You mark the moments
in your app that matter. Tripcord keeps the most recent ones in the user's tab and
sends nothing. When an error is thrown, or you call `capture()`, it sends that short
timeline to your server, where you can read what the user did right before things
went wrong.

A stack trace tells you where the code failed. A Tripcord timeline tells you what
the user did to get there:

```text
TypeError: Cannot read properties of undefined (reading 'price')
on /checkout · tagged checkout

   −41.2s  trace   "Add to cart"
   −18.7s  custom  checkout.step    { step: "shipping" }
    −6.3s  trace   "Apply coupon"
    −1.1s  custom  coupon.applied   { code: "SPRING", valid: false }
     0.0s  error   TypeError: Cannot read properties of undefined (reading 'price')
```

## How it works

1. **You instrument.** Call `track("checkout.step", { step: "shipping" })`, or add
   `data-trace="Apply coupon"` to an element. Only what you mark is recorded:
   no DOM snapshots, no keystrokes, no network logs.
2. **The client waits.** `@tripcord/js` keeps the last 50 events in
   `sessionStorage`, so the timeline survives page loads within the tab. Nothing
   leaves the browser.
3. **Something breaks.** An uncaught error, an unhandled rejection, a React error
   boundary, or your own `capture("payment-declined")` sends the timeline to your
   Tripcord server.
4. **You read it.** The dashboard lists timelines by volume, reason and tag, and
   links timelines from the same session together.

## Why not session replay, or an error tracker?

| | Error tracker | Session replay | Tripcord |
| --- | --- | --- | --- |
| What you get | A stack trace | A recording of everything | The steps you chose to mark |
| What leaves the browser | Errors | Everything, all the time | A short timeline, only when something breaks |
| Keeping personal data out | Mostly easy | Masking rules and audits | You write every event, so you decide |
| Payload size | Small | Large | Small |

Tripcord doesn't replace an error tracker. It answers the question the stack trace
leaves open: *what did the user do before this broke?*

## Quick start

**1. Run a server.** Tripcord is self-hosted: one Docker image (the API plus the
dashboard) and Postgres. See [Self-hosting](docs/self-hosting.md). It takes a
Compose file, two settings and `docker compose up -d`.

**2. Install the client** and point it at your server, using an API key from the
dashboard:

```bash
npm i @tripcord/js
```

```ts
import { init, track, setTags } from "@tripcord/js";

init({
  endpoint: "https://tripcord.example.com/v1/timeline",
  apiKey: "rpk_…",
});

setTags(["checkout"]);                       // which area of the app this is
track("checkout.step", { step: "shipping" }); // a moment worth remembering
```

```html
<button data-trace="Apply coupon">Apply</button>
```

Uncaught errors are captured automatically. For React, wrap your tree in
`<ErrorBoundary>` from `@tripcord/js/react`. The
[client README](packages/js/README.md) covers tags, manual captures and
controlling which page URLs are sent.

## Status

Tripcord is early, and the idea is still being tested on real apps. What exists
today:

- **`@tripcord/js`**: the browser client, with a framework-agnostic core and a React
  error boundary. TypeScript, ESM and CommonJS.
- **The server**: the ingest API, with API keys per project and rate limits, and
  a dashboard with accounts, orgs, invites, GitHub login and a timeline viewer.
  Released as a Docker image for amd64 and arm64.

Not yet: a hosted version, server-side (SSR) tracing, alerts, and grouping of
similar errors.

## Repository

| Path | What it is |
| --- | --- |
| [`packages/js`](packages/js) | `@tripcord/js`, the browser client, published to npm |
| [`server`](server) | The ingest API and dashboard backend (Fastify, Postgres). Its README covers configuration and running from source. |
| [`dashboard`](dashboard) | The dashboard (React SPA), built into and served by the server |
| [`deploy`](deploy) | The Compose file for running a released image |
| [`docs`](docs) | [Self-hosting](docs/self-hosting.md), [releasing](docs/releasing.md), and the design specs in [`docs/superpowers/specs`](docs/superpowers/specs) |

## Development

An npm workspaces monorepo. Server tests need Docker (they start Postgres with
testcontainers).

```bash
npm install
npm run build        # every workspace
npm test             # every workspace, plus the release scripts' tests
npm run lint
npm run typecheck
docker compose up -d --build   # server + Postgres from source, on localhost:3000
```

CI runs all of this on every push. Releases are cut from git tags; see
[`docs/releasing.md`](docs/releasing.md).

## License

MIT — see [`LICENSE`](LICENSE).
