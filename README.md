# Tripcord

**Mark the moments that matter in your app. When one happens, Tripcord sends you the path that led there.**

[![CI](https://github.com/jonaszbigda/tripcord/actions/workflows/ci.yml/badge.svg)](https://github.com/jonaszbigda/tripcord/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tripcord/js)](https://www.npmjs.com/package/@tripcord/js)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Tripcord is a self-hosted timeline tool for web apps. You decide which steps are
worth recording. The browser keeps the most recent ones and sends nothing, until
something happens that you care about. That might be a crash, or it might be a
checkout, an abandoned form, or a signup. Then Tripcord sends the short timeline
that led up to it to your server.

No noise, only signal: every event on a timeline is one you chose to record.

## One tool, two questions

**Why did this break?** Uncaught errors are captured automatically. A stack trace
tells you where the code failed. The timeline tells you what the user did to get
there:

```text
TypeError: Cannot read properties of undefined (reading 'price')
on /checkout · tagged checkout

   −41.2s  trace   "Add to cart"
   −18.7s  custom  checkout.step    { step: "shipping" }
    −6.3s  trace   "Apply coupon"
    −1.1s  custom  coupon.applied   { code: "SPRING", valid: false }
```

**How did people get here?** Call `capture()` at any moment that matters to you,
not just failures. The dashboard counts each moment over time, ranks them, filters
them by area of the app, and shows the path behind every one:

```text
signup.completed { plan: "team" }
on /welcome · tagged onboarding

   −95.0s  trace   "Pricing: Team plan"
   −61.4s  custom  signup.step      { step: "account" }
   −22.8s  custom  signup.step      { step: "invite_team", invited: 3 }
```

## How it works

1. **You instrument.** Call `track("checkout.step", { step: "shipping" })`, or add
   `data-trace="Apply coupon"` to an element. Only what you mark is recorded:
   no DOM snapshots, no keystrokes, no network logs.
2. **The client waits.** `@tripcord/js` keeps the last 50 events in
   `sessionStorage`, so the timeline survives page loads within the tab. Nothing
   leaves the browser.
3. **A moment happens.** An uncaught error, an unhandled rejection, a React error
   boundary, or your own `capture("signup.completed")` sends the timeline to your
   Tripcord server.
4. **You read it.** The dashboard charts volume over time, ranks the most common
   errors and captures, filters by tag, and links timelines from the same session
   together.

## How it compares

|  | Error tracker | Session replay | Product analytics | Tripcord |
| --- | --- | --- | --- | --- |
| What you get | A stack trace | A recording of everything | Aggregate counts and funnels | The path to each moment you mark |
| When data is sent | On errors | Continuously | On every event | Only when a marked moment happens |
| What's sent | The error | Everything on the page | Every tracked event | A short timeline you wrote |
| Keeping personal data out | Mostly easy | Masking rules and audits | Per-event review | You write every event, so you decide |

Tripcord sits between these tools. An error tracker tells you what failed, and
analytics tells you how many. Tripcord shows the steps an individual user took to
reach a moment, and how often that moment happens.

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
import { init, track, capture, setTags } from "@tripcord/js";

init({
  endpoint: "https://tripcord.example.com/v1/timeline",
  apiKey: "tpk_…",
});

setTags(["onboarding"]);                       // which area of the app this is
track("signup.step", { step: "account" });     // a step worth remembering
capture("signup.completed", { plan: "team" }); // a moment worth a timeline
```

```html
<button data-trace="Pricing: Team plan">Choose Team</button>
```

Uncaught errors are captured without any code. For React, wrap your tree in
`<ErrorBoundary>` from `@tripcord/js/react`. The
[client README](packages/js/README.md) covers tags, manual captures and
controlling which page URLs are sent.

## Status

Tripcord is early, and the idea is still being tested on real apps. What exists
today:

- **`@tripcord/js`**: the browser client, with a framework-agnostic core and a React
  error boundary. TypeScript, ESM and CommonJS.
- **The server**: the ingest API, with API keys per project and rate limits, and
  a dashboard with accounts, orgs, invites, GitHub login and a timeline viewer:
  a volume chart, top errors and captures, tag filters, and per-timeline detail.
  Released as a Docker image for amd64 and arm64.

Not yet: a hosted version, clients for platforms other than the browser,
server-side (SSR) tracing, alerts, grouping similar errors, and analytics across
timelines, such as funnels or the most common paths to a moment.

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
