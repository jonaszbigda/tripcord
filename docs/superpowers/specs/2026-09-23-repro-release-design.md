# Tripcord — first release: rename, packaging, CI and self-hosting design

Status: approved
Date: 2026-09-23 (revised 2026-09-24: product renamed from repro to Tripcord)
Scope: making Tripcord installable by someone other than its author. This covers
renaming the product from repro to Tripcord, the npm package (`@tripcord/js`), a
versioned multi-arch server image on GHCR, CI that checks every push, tag-driven
release workflows, a self-hosting guide, and a period of dogfooding. No product
features.

## Problem & concept

Every approved spec is built, but the product only runs from a clone of this
repository:

- The client has never been published, and its name, `@repro/js`, can't be: the
  `repro` org on npm belongs to someone else.
- The name "repro" itself is taken in practice: an existing open-source project,
  ReproJs, does frontend bug reporting under it. The product is renamed to
  **Tripcord**. It stays quiet until something goes wrong, and then it sends the
  timeline that led up to it. The name also carries no "js" or "bug", which leaves
  room for clients on other platforms later.
- The server image is only built locally by `docker compose`. There's no versioned
  image to pull, so there's nothing stable to upgrade from or to.
- Nothing runs the test suite on push. The 416 tests only run when someone
  remembers to.
- There's no guide for running it anywhere but a laptop.

The client spec calls the idea itself "not validated yet". Features like issue
grouping or alerts are guesses until someone uses Tripcord on a real app. This
sub-project gets it into a state where that can happen, starting with its author.

## Decisions

| Question | Decision |
| --- | --- |
| Product name | Tripcord. Domain `tripcord.dev` (registered). |
| npm name | `@tripcord/js`, in the `tripcord` npm org (created). Subpaths: `@tripcord/js/react` today, `@tripcord/js/node` for the future SSR adapter. Clients for other platforms would be siblings (`@tripcord/<platform>`) where they ship through npm at all. |
| Repository | Renamed on GitHub from `jonaszbigda/repro` to `jonaszbigda/tripcord` (done 2026-09-24), before any release workflow runs. GitHub redirects the old URLs. |
| Old names on the wire and in storage | Renamed with no compatibility shims. Nothing has shipped, so there are no clients, cookies or databases to stay compatible with. |
| Versioning | Independent per package, driven by git tags: `js-vX.Y.Z` releases the client, `server-vX.Y.Z` releases the server image |
| Image registry and platforms | `ghcr.io/jonaszbigda/tripcord`, `linux/amd64` and `linux/arm64` |
| npm authentication | Trusted publishing (OIDC) from GitHub Actions, with provenance. The first version is published by hand. |
| First versions | `@tripcord/js@0.2.0` (already built, unreleased) and server `0.1.0` |

## Renaming repro to Tripcord

The rename is one mechanical change across the repo, done before anything else in
this spec. Directory names (`packages/js`, `server`, `dashboard`) stay as they are.

**Packages.**
- Root `package.json`: `"name": "tripcord"`.
- `packages/js/package.json`: `"name": "@tripcord/js"`, `"repository.url"`
  pointing at `jonaszbigda/tripcord`, `"repository.directory": "packages/js"`,
  `"homepage": "https://tripcord.dev"`, `keywords`, and `"publishConfig": {
  "access": "public", "provenance": true }`. Scoped packages are private by
  default, so `access: public` is required.
- `packages/js/LICENSE`: a copy of the root `LICENSE`. npm only packs a license
  file from the package's own directory, and `files: ["dist"]` doesn't cover it.
- The private workspaces become `@tripcord/server` and `@tripcord/dashboard`.
  They're never published. The org means nobody else can take those names either.
- `server/package.json`: the dependency becomes `"@tripcord/js": "^0.2.0"`, and the
  `prebuild` / `pretypecheck` scripts become `npm run build -w @tripcord/js`.
- `server/src/routes/timeline.ts`: `import type { TimelinePayload } from
  "@tripcord/js"`. It's type-only, so nothing changes at runtime, and the image
  needs no new files.

**On the wire and in the browser.**
- The API key header becomes `X-Tripcord-Key`: in the client's transport, in the
  server's CORS `allowedHeaders` and key lookup, and in `server/README.md`.
- Cookies: `repro_session` becomes `tripcord_session`, and `repro_oauth` becomes
  `tripcord_oauth`.
- Client `sessionStorage` keys: `__tripcord_buffer` and `__tripcord_session_id`.
- Dashboard `localStorage`: `tripcord.chartMode`.
- The GitHub API `User-Agent` becomes `tripcord`.

**What people see.**
- Client console warnings use the `[tripcord]` prefix, and server logs use
  `[tripcord-server]`.
- The admin CLI's usage text says `tripcord-admin`.
- The dashboard's `<title>`, the wordmark in `AppShell.tsx`, and the one in
  `ui.tsx` say "Tripcord".
- The setup snippet in `EmptyState.tsx` and the text on the Keys tab import from
  `"@tripcord/js"`.
- READMEs (root, `packages/js`, `server`): the install line becomes
  `npm i @tripcord/js`, and imports become `"@tripcord/js"` /
  `"@tripcord/js/react"`.
- Example URLs in tests and comments (`app.reprojs.dev`) become `app.tripcord.dev`.

**Development setup.** In `docker-compose.yml`, the Postgres user, password,
database and volume become `tripcord` / `tripcord-postgres-data`. An existing local
database isn't carried over. `docker compose down -v` followed by `up` starts
fresh, which is fine before a first release.

**Docs.** The older specs and plans keep "repro" and `@repro/js` in their text,
following the "superseded notes, not rewrites" convention. The client spec gets one
note at the top saying the product and package were renamed. Spec file names keep
their `repro-` prefix, and new specs use `tripcord-`.

## CI (`.github/workflows/ci.yml`)

It runs on every push to `main` and on every pull request, and other workflows can
call it (`workflow_call`), so releases run the same checks.

- `ubuntu-latest`, Node 22, `npm ci` with the npm cache.
- `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`. The server tests
  start Postgres with testcontainers. GitHub's Linux runners have Docker, so they
  run exactly as they do locally.
- A second job builds the server image for `linux/amd64` without pushing it, so a
  broken Dockerfile fails CI instead of failing a release.

## Client release (`.github/workflows/release-js.yml`)

It triggers on tags matching `js-v*`.

1. Calls the CI workflow.
2. Checks that the tag's version equals `packages/js/package.json`'s `version`. A
   tag `js-v0.2.1` on a commit where the package still says `0.2.0` fails before
   anything is published. A small script, `scripts/check-tag-version.mjs <tag>
   <package.json>`, does this check, and both release workflows use it.
3. Builds and publishes with `npm publish -w @tripcord/js`, using trusted publishing:
   the job has `permissions: id-token: write` and no npm token. The npm CLI must be
   new enough for trusted publishing (11.5.1 or later at the time of writing), so
   the workflow installs it explicitly rather than relying on the version bundled
   with Node.

**First release, by hand.** npm can only set up a trusted publisher for a package
that already exists. So `0.2.0` is published once from a logged-in machine
(`npm publish -w @tripcord/js --provenance=false`), without provenance, since that
can only be generated in CI. The flag overrides `publishConfig`. Then the trusted publisher is configured on npmjs.com for this repository and
`release-js.yml`. From `0.2.1` on, releases go through the workflow. The
`tripcord` org already reserves the `@tripcord/` scope, so there's no race to claim
the name.

## Server release (`.github/workflows/release-server.yml`)

It triggers on tags matching `server-v*`.

1. Calls the CI workflow.
2. Checks the tag against `server/package.json`'s `version` with the same script.
3. Builds with Buildx for `linux/amd64,linux/arm64` (QEMU for arm64). It logs in to
   GHCR with the workflow's own `GITHUB_TOKEN` (`permissions: packages: write`), so
   there's no registry secret.
4. Tags the image `X.Y.Z`, `X.Y` and `latest`, using `docker/metadata-action` with a
   pattern that takes the version out of `server-vX.Y.Z`. It also adds the
   `org.opencontainers.image.source` label, so GHCR links the package to the
   repository.

**Dockerfile changes:**
- The `dashboard-build` stage becomes `FROM --platform=$BUILDPLATFORM …`. Its
  output is static files, so it builds once, natively, whatever the target. That
  also avoids resolving Tailwind's native binary under emulation.
- The `build` and `runtime` stages run per platform. The server has no native
  runtime dependencies, so the arm64 build under QEMU is slower but not different.

**First release:** GHCR creates a new package as private. After the first push, the
package is made public once in its GitHub settings. `docker pull` without a login
fails until then.

## Server version in `/health`

`GET /health` returns `{ "status": "ok", "version": "0.1.0" }`. The version is read
from `server/package.json` at startup, which the image already contains. That lets
an operator, or the self-hosting guide's upgrade steps, confirm what's running.
`server/package.json`'s version goes from `0.0.1` to `0.1.0`.

## Compatibility between client and server

The two are versioned independently, so the client README has a short table saying
which server version each client feature needs:

| @tripcord/js | Needs server |
| --- | --- |
| 0.2.x, with tags | 0.1.0 or later |
| 0.2.x, without tags | any |

A new row is added whenever a client feature depends on a server change. The
server always accepts older clients' payloads: the ingest schema only ever gains
optional fields.

## Self-hosting guide (`docs/self-hosting.md`)

It's linked from the root README, and it comes with a ready-to-use
`deploy/docker-compose.yml` that pulls `ghcr.io/jonaszbigda/tripcord:0.1` instead of
building from source. The root `docker-compose.yml` stays as the development setup.

It covers:
- **Running:** the compose file, generating a Postgres password, and setting
  `PUBLIC_URL`.
- **First account:** the bootstrap signup, and `SIGNUP` open vs invite-only.
- **HTTPS:** running behind a reverse proxy, with a Caddy example and when to set
  `TRUST_PROXY`.
- **GitHub login:** setting up the OAuth app.
- **Configuration:** a pointer to `server/README.md` for every environment variable.
- **Upgrading:** pin an `X.Y` tag, pull, restart. Migrations run on start behind an
  advisory lock. Check `/health` for the new version.
- **Backups:** a `pg_dump` / `pg_restore` pair, and the reminder that retention
  already deletes timelines older than `RETENTION_DAYS`.
- **Connecting the client:** `npm i @tripcord/js`, and pointing `init()` at
  `${PUBLIC_URL}/v1/timeline`.

## Release checklist (`docs/releasing.md`)

**One-time setup**, which needs the maintainer's accounts:
1. Rename the GitHub repository to `jonaszbigda/tripcord`. The trusted publisher
   and the GHCR package are tied to the repository name, so this comes first.
   (Done 2026-09-24.)
2. Publish `@tripcord/js@0.2.0` by hand, with `--provenance=false`.
3. Configure the npm trusted publisher.
4. After the first server release, make the GHCR package public.

**Each release:** bump the version in the package's `package.json`, commit, tag
`js-vX.Y.Z` or `server-vX.Y.Z`, and push the tag. If the client needs a newer
server, add a row to the compatibility table.

## Dogfooding

This is a checklist, not code. It's the reason for the release:

- Run a released server image somewhere other than a laptop.
- Instrument one real app with `@tripcord/js` from npm, using `setTags` for its main
  areas.
- Use it for one to two weeks. Note every time the dashboard answered, or failed to
  answer, "what did the user do before this broke?".
- Record findings in a short note next to this spec, as input for choosing the next
  sub-project (issue grouping, alerts, search, or none of them).

## Testing

- CI is the test for this sub-project's workflows. Every push runs the full suite
  and builds the image.
- `scripts/check-tag-version.mjs` gets a unit test for a matching tag, a mismatched
  tag, and a malformed tag.
- `/health`: the existing tests in `app.test.ts` and `static.test.ts` expect
  `version` equal to `server/package.json`'s.
- **Rename:** the whole-repo build, typecheck and tests pass with the new name, and
  `npm pack --dry-run -w @tripcord/js` lists `dist/`, `README.md`, `LICENSE` and
  `package.json`, and nothing else.
- **Manual:** after the first releases, a clean directory can run `npm i @tripcord/js`
  and import both entry points. On an arm64 machine, `docker pull
  ghcr.io/jonaszbigda/tripcord:0.1` gets an arm64 image, and `deploy/docker-compose.yml`
  starts the server with a healthy `/health`.

## Explicitly out of scope

- The marketing site at `tripcord.dev`.
- Hosted SaaS: multi-region, managed backups, billing.
- Changelog tooling (changesets, release-please) and generated release notes.
- Docker Hub, or any registry other than GHCR.
- Preview images or canary npm versions built from `main`.
- Slimming the image, for example leaving dev dependencies out of the runtime stage.
- Signing images (cosign) beyond npm's provenance.
