# repro

Monorepo for `repro` — an opt-in, developer-instrumented breadcrumb timeline for
frontend bug reproduction.

## Packages

- [`packages/js`](packages/js) — `@repro/js`, the browser client library. Built,
  tested, not yet published to npm.
- [`server`](server) — `@repro/server`, the ingest API that receives what the client
  sends. Built, tested, self-hostable via `docker compose up` — see
  [`server/README.md`](server/README.md) for how to run it and provision an API key.
- [`dashboard`](dashboard) — `@repro/dashboard`, the web dashboard (React SPA) where
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

## License

MIT — see [`LICENSE`](LICENSE).
