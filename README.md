# repro

Monorepo for `repro` — an opt-in, developer-instrumented breadcrumb timeline for
frontend bug reproduction.

## Packages

- [`packages/js`](packages/js) — `@repro/js`, the browser client library. Built,
  tested, not yet published to npm.
- `server` — the ingest API that receives what the client sends. Coming soon.

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
