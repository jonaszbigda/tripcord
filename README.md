# Tripcord

Monorepo for Tripcord — an opt-in, developer-instrumented breadcrumb timeline for
frontend bug reproduction.

## Packages

- [`packages/js`](packages/js) — `@tripcord/js`, the browser client library,
  published to npm (`npm i @tripcord/js`).
- [`server`](server) — `@tripcord/server`, the ingest API that receives what the client
  sends. Released as the `ghcr.io/jonaszbigda/tripcord` Docker image — see
  [`docs/self-hosting.md`](docs/self-hosting.md) to run it, and
  [`server/README.md`](server/README.md) for configuration and running from source.
- [`dashboard`](dashboard) — `@tripcord/dashboard`, the web dashboard (React SPA) where
  users sign up, manage orgs and members, and create projects and API keys. Built into
  and served by the server.

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

CI runs build, typecheck, lint and tests on every push. Releases are cut from git
tags; see [`docs/releasing.md`](docs/releasing.md).

## License

MIT — see [`LICENSE`](LICENSE).
