# repro — first release: packaging, CI and self-hosting design

Status: draft
Date: 2026-09-23
Scope: making repro installable by someone other than its author. This covers the npm
package (renamed to `reprojs`), a versioned multi-arch server image on GHCR, CI that
checks every push, tag-driven release workflows, a self-hosting guide, and a period
of dogfooding. No product features.

## Problem & concept

Every approved spec is built, but repro only runs from a clone of this repository:

- The client has never been published, and its name, `@repro/js`, can't be: the
  `repro` org on npm belongs to someone else.
- The server image is only built locally by `docker compose`. There's no versioned
  image to pull, so there's nothing stable to upgrade from or to.
- Nothing runs the test suite on push. The 416 tests only run when someone
  remembers to.
- There's no guide for running it anywhere but a laptop.

The client spec calls the idea itself "not validated yet". Features like issue
grouping or alerts are guesses until someone uses repro on a real app. This
sub-project gets it into a state where that can happen, starting with its author.

## Decisions

| Question | Decision |
| --- | --- |
| npm name | `reprojs`, unscoped. Subpaths: `reprojs/react` today, `reprojs/node` for the future SSR adapter. |
| If npm rejects `reprojs` at first publish | `@reprojs/js`, which needs a `reprojs` npm org. The rename is mechanical either way. |
| Versioning | Independent per package, driven by git tags: `js-vX.Y.Z` releases the client, `server-vX.Y.Z` releases the server image |
| Image registry and platforms | `ghcr.io/jonaszbigda/repro`, `linux/amd64` and `linux/arm64` |
| npm authentication | Trusted publishing (OIDC) from GitHub Actions, with provenance. The first version is published by hand. |
| First versions | `reprojs@0.2.0` (already built, unreleased) and server `0.1.0` |

## Renaming the client to `reprojs`

The directory stays `packages/js`. Only the package name changes.

- `packages/js/package.json`: `"name": "reprojs"`. Add `"repository.directory":
  "packages/js"`, `"homepage": "https://reprojs.dev"`, `keywords`, and
  `"publishConfig": { "provenance": true }`. Unscoped packages are public by default.
- `packages/js/LICENSE`: a copy of the root `LICENSE`. npm only packs a license
  file from the package's own directory, and `files: ["dist"]` doesn't cover it.
- `server/package.json`: the dependency becomes `"reprojs": "^0.2.0"`, and the
  `prebuild` / `pretypecheck` scripts become `npm run build -w reprojs`.
- `server/src/routes/timeline.ts`: `import type { TimelinePayload } from "reprojs"`.
  It's type-only, so nothing changes at runtime, and the image needs no new files.
- The dashboard's setup snippet (`EmptyState.tsx`) and the Keys tab's text import
  from `"reprojs"`.
- READMEs (root, `packages/js`, `server`): the install line becomes `npm i reprojs`,
  and imports become `"reprojs"` / `"reprojs/react"`.
- The older specs keep `@repro/js` in their text, following the "superseded notes,
  not rewrites" convention. The client spec gets one note that the package was
  renamed.
- The private workspaces `@repro/server` and `@repro/dashboard` are never published
  and keep their names.

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
3. Builds and publishes with `npm publish -w reprojs`, using trusted publishing:
   the job has `permissions: id-token: write` and no npm token. The npm CLI must be
   new enough for trusted publishing (11.5.1 or later at the time of writing), so
   the workflow installs it explicitly rather than relying on the version bundled
   with Node.

**First release, by hand.** npm can only set up a trusted publisher for a package
that already exists. So `0.2.0` is published once from a logged-in machine
(`npm publish -w reprojs`), without provenance, since that can only be generated in
CI. Then the trusted publisher is configured on npmjs.com for this repository and
`release-js.yml`. From `0.2.1` on, releases go through the workflow. Publishing
`0.2.0` early is also how the name gets claimed: npm doesn't reserve names.

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

| reprojs | Needs server |
| --- | --- |
| 0.2.x, with tags | 0.1.0 or later |
| 0.2.x, without tags | any |

A new row is added whenever a client feature depends on a server change. The
server always accepts older clients' payloads: the ingest schema only ever gains
optional fields.

## Self-hosting guide (`docs/self-hosting.md`)

It's linked from the root README, and it comes with a ready-to-use
`deploy/docker-compose.yml` that pulls `ghcr.io/jonaszbigda/repro:0.1` instead of
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
- **Connecting the client:** `npm i reprojs`, and pointing `init()` at
  `${PUBLIC_URL}/v1/timeline`.

## Release checklist (`docs/releasing.md`)

**One-time setup**, which needs the maintainer's accounts:
1. Publish `reprojs@0.2.0` by hand.
2. Configure the npm trusted publisher.
3. Optionally, create the `reprojs` npm org to protect `@reprojs/*`.
4. After the first server release, make the GHCR package public.

**Each release:** bump the version in the package's `package.json`, commit, tag
`js-vX.Y.Z` or `server-vX.Y.Z`, and push the tag. If the client needs a newer
server, add a row to the compatibility table.

## Dogfooding

This is a checklist, not code. It's the reason for the release:

- Run a released server image somewhere other than a laptop.
- Instrument one real app with `reprojs` from npm, using `setTags` for its main
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
  `npm pack --dry-run -w reprojs` lists `dist/`, `README.md`, `LICENSE` and
  `package.json`, and nothing else.
- **Manual:** after the first releases, a clean directory can run `npm i reprojs`
  and import both entry points. On an arm64 machine, `docker pull
  ghcr.io/jonaszbigda/repro:0.1` gets an arm64 image, and `deploy/docker-compose.yml`
  starts the server with a healthy `/health`.

## Explicitly out of scope

- The marketing site at `reprojs.dev`.
- Hosted SaaS: multi-region, managed backups, billing.
- Changelog tooling (changesets, release-please) and generated release notes.
- Docker Hub, or any registry other than GHCR.
- Preview images or canary npm versions built from `main`.
- Slimming the image, for example leaving dev dependencies out of the runtime stage.
- Signing images (cosign) beyond npm's provenance.
