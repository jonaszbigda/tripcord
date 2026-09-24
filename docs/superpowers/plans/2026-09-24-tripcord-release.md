# Tripcord First Release: CI, Release Workflows, Self-Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Tripcord installable by someone other than its author: `/health` reports the server version, CI checks every push, `js-v*` / `server-v*` tags publish `@tripcord/js` to npm and a multi-arch image to GHCR, and a self-hosting guide plus release checklist exist.

**Architecture:** Most of this is repo configuration, not product code.
- **Server:** one new module, `server/src/version.ts`, reads `server/package.json` at startup. `/health` returns it.
- **`scripts/check-tag-version.mjs`:** a dependency-free Node script that both release workflows run before they publish. It's tested with `node:test`, so the repo root needs no test framework.
- **Workflows:** `ci.yml` is reusable (`workflow_call`), and both release workflows call it, so a release runs exactly the checks a push does.
- **Docs:** `docs/self-hosting.md` + `deploy/docker-compose.yml` for operators. `docs/releasing.md` for the maintainer.

**Tech Stack:** GitHub Actions, Docker Buildx + QEMU, `docker/metadata-action`, npm trusted publishing (OIDC), Node 22 `node:test`, Fastify 5, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-09-23-repro-release-design.md`

## Global Constraints

- **The rename is done** (`9c67980`), and so is the GitHub repository rename to `jonaszbigda/tripcord` (`origin` already points there). No task touches names.
- **No new dependency** in any workspace. The tag script uses only Node built-ins.
- **Versions:** `server/package.json` goes to `0.1.0`. `@tripcord/js` stays `0.2.0`, which is the first version to publish.
- **Tags:** `js-vX.Y.Z` and `server-vX.Y.Z`, with plain `X.Y.Z` and no prerelease suffix. The tag script rejects anything else.
- **No secrets in any workflow.** npm uses OIDC (`id-token: write`), and GHCR uses the workflow's own `GITHUB_TOKEN` (`packages: write`). Each job gets only the `permissions` it needs, and the workflow default is `contents: read`.
- **The image name is `ghcr.io/jonaszbigda/tripcord`**, hard-coded rather than derived from `github.repository`, so a fork can't push to a surprising name.
- **Action versions:** the steps below pin `actions/checkout@v5`, `actions/setup-node@v5`, `docker/setup-qemu-action@v3`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`, `docker/metadata-action@v5` and `docker/build-push-action@v6`. Before committing, check each action's releases page. If a newer major exists, use it and check its changelog for breaking input changes.
- **Development setup is unchanged.** The root `docker-compose.yml` still builds from source. Only `deploy/docker-compose.yml` pulls the image.

## Review Focus

These are the parts most likely to be wrong while everything looks fine locally.

1. **The tag check runs before anything is published.** In both release workflows, the publish job `needs` the tag job and the CI job. A mismatched tag must never reach `npm publish` or `docker push`. (Tasks 4, 5)
2. **`npm publish` ships a fresh build.** `packages/js` gets a `prepack` script, so both the manual first publish and the workflow build `dist/` first. `npm pack --dry-run` lists `dist/`, `README.md`, `LICENSE` and `package.json`, and nothing else. (Task 4)
3. **The `/health` version matches the package.json that's actually on disk**, both in `src/` under Vitest and in `dist/` in the image. The test reads `server/package.json` itself rather than importing the module under test. (Task 1)
4. **Image tags.** `server-v0.1.0` produces exactly `0.1.0`, `0.1` and `latest`, and the `org.opencontainers.image.source` label points at the repository. (Task 5)
5. **The arm64 image is really arm64.** `uname -m` in the image built for `linux/arm64` prints `aarch64`, and the dashboard stage runs once, natively. (Task 5)

## Prerequisites

From the repo root, once: `npm install`. Docker must be running for the server tests and for the image steps.

Commands: `npm test -w server` (a single file: `npm test -w server -- src/app.test.ts`), `node --test "scripts/*.test.mjs"`. Whole repo: `npm run build && npm run typecheck && npm run lint && npm test`.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `server/src/version.ts` | create | `SERVER_VERSION`, read from `server/package.json` |
| `server/src/app.ts` | modify | `/health` returns `{ status, version }` |
| `server/src/app.test.ts`, `server/src/static.test.ts` | modify | expect `version` |
| `server/package.json`, `package-lock.json` | modify | version `0.1.0` |
| `scripts/check-tag-version.mjs` | create | tag ⇄ package.json version check (CLI + exported function) |
| `scripts/check-tag-version.test.mjs` | create | `node:test` unit tests |
| `package.json` (root) | modify | `test` also runs the script tests |
| `.github/workflows/ci.yml` | create | build, typecheck, lint, test; build the image without pushing |
| `.github/workflows/release-js.yml` | create | `js-v*` → npm, trusted publishing |
| `.github/workflows/release-server.yml` | create | `server-v*` → GHCR, amd64 + arm64 |
| `packages/js/package.json` | modify | `prepack: npm run build` |
| `server/Dockerfile` | modify | dashboard stage on `$BUILDPLATFORM` |
| `deploy/docker-compose.yml`, `deploy/.env.example` | create | production compose that pulls the image |
| `docs/self-hosting.md` | create | the operator guide |
| `docs/releasing.md` | create | one-time setup + per-release checklist |
| `README.md`, `server/README.md`, `packages/js/README.md` | modify | install lines, links, compatibility table, `/health` |
| `docs/superpowers/specs/2026-09-22-repro-client-library-design.md` | modify | rename note at the top |

---

### Task 1: Server version in `/health`

**Files:**
- Create: `server/src/version.ts`
- Modify: `server/src/app.ts`, `server/src/app.test.ts`, `server/src/static.test.ts`, `server/package.json`, `package-lock.json`

- [x] **Step 1: Update the tests to expect a version**

In `server/src/app.test.ts`, add to the imports:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
```

and replace the `GET /health` block with:

```ts
describe("GET /health", () => {
  it("returns 200 with status ok and the version from server/package.json", async () => {
    const { version } = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    const app = await buildApp(getTestDb());
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version });
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

In `server/src/static.test.ts`, in "keeps JSON 404s for API paths and non-GET requests", replace the last assertion with:

```ts
    expect((await call(app, "GET", "/health")).json()).toMatchObject({ status: "ok" });
```

The version is pinned in `app.test.ts`. This test only checks that `/health` isn't swallowed by the SPA fallback.

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- src/app.test.ts`
Expected: FAIL. The response lacks `version`.

- [x] **Step 3: Implement**

Create `server/src/version.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

// src/version.ts (tests) and dist/version.js (built, and in the Docker image)
// both sit one level below server/package.json.
export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string }
).version;
```

In `server/src/app.ts`, import it:

```ts
import { SERVER_VERSION } from "./version";
```

and change the health route to:

```ts
  app.get("/health", async () => {
    return { status: "ok", version: SERVER_VERSION };
  });
```

In `server/package.json`, set `"version": "0.1.0"`. Then run `npm install` from the root so `package-lock.json` records the workspace's new version.

- [x] **Step 4: Run the server tests**

Run: `npm test -w server`
Expected: PASS, including `GET /health` with `version: "0.1.0"`.

Also run `npm run build -w server && node -e "console.log(require('./server/dist/version.js').SERVER_VERSION)"`.
Expected: `0.1.0`. This proves the `dist/` path resolves too.

- [x] **Step 5: Update the server README**

In `server/README.md`, change the health-check comment under "Running it" to `# {"status":"ok","version":"0.1.0"}`. In "## API", change the `/health` line to:

```markdown
`GET /health` — liveness check, always `200 { status: "ok", version }`, where
`version` is the running server's version.
```

- [x] **Step 6: Commit**

```bash
git add server/src/version.ts server/src/app.ts server/src/app.test.ts server/src/static.test.ts server/package.json package-lock.json server/README.md
git commit -m "feat(server): report the server version in /health; bump to 0.1.0"
```

---

### Task 2: `scripts/check-tag-version.mjs`

**Files:**
- Create: `scripts/check-tag-version.mjs`, `scripts/check-tag-version.test.mjs`
- Modify: `package.json` (root)

- [x] **Step 1: Write the failing tests**

Create `scripts/check-tag-version.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTagVersion } from "./check-tag-version.mjs";

const script = fileURLToPath(new URL("./check-tag-version.mjs", import.meta.url));

test("a tag matching the package version passes", () => {
  assert.equal(checkTagVersion("js-v0.2.0", "0.2.0"), null);
  assert.equal(checkTagVersion("server-v10.20.30", "10.20.30"), null);
});

test("a tag with a different version fails and names both versions", () => {
  const error = checkTagVersion("js-v0.2.1", "0.2.0");
  assert.match(error, /0\.2\.1/);
  assert.match(error, /0\.2\.0/);
});

test("malformed tags fail", () => {
  for (const tag of ["v0.2.0", "js-0.2.0", "js-v0.2", "js-v0.2.0-beta.1", "js-v0.2.0 ", "-v0.2.0", ""]) {
    assert.match(checkTagVersion(tag, "0.2.0") ?? "", /Malformed tag/, `tag ${JSON.stringify(tag)}`);
  }
});

test("the CLI exits 0 on a match and 1 on a mismatch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tripcord-tag-"));
  try {
    const pkg = path.join(dir, "package.json");
    writeFileSync(pkg, JSON.stringify({ version: "0.1.0" }));
    assert.equal(spawnSync(process.execPath, [script, "server-v0.1.0", pkg]).status, 0);
    const mismatch = spawnSync(process.execPath, [script, "server-v0.1.1", pkg], { encoding: "utf8" });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /0\.1\.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI exits 2 without arguments", () => {
  assert.equal(spawnSync(process.execPath, [script]).status, 2);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test "scripts/*.test.mjs"`
Expected: FAIL. `check-tag-version.mjs` doesn't exist.

- [x] **Step 3: Implement**

Create `scripts/check-tag-version.mjs`:

```js
// Usage: node scripts/check-tag-version.mjs <tag> <path/to/package.json>
// Release workflows run this before publishing. It fails unless <tag> is
// <name>-vX.Y.Z and X.Y.Z equals the package.json "version".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TAG = /^[a-z][a-z0-9-]*-v(\d+\.\d+\.\d+)$/;

/** Returns null when the tag matches, otherwise an error message. */
export function checkTagVersion(tag, packageVersion) {
  const match = TAG.exec(tag);
  if (!match) {
    return `Malformed tag ${JSON.stringify(tag)}: expected <name>-vX.Y.Z`;
  }
  if (match[1] !== packageVersion) {
    return `Tag ${tag} is version ${match[1]}, but package.json says ${packageVersion}`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, packageJsonPath] = process.argv.slice(2);
  if (!tag || !packageJsonPath) {
    console.error("Usage: node scripts/check-tag-version.mjs <tag> <package.json>");
    process.exit(2);
  }
  const { version } = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const error = checkTagVersion(tag, version);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`${tag} matches ${packageJsonPath} (${version})`);
}
```

- [x] **Step 4: Run the tests**

Run: `node --test "scripts/*.test.mjs"`
Expected: PASS, 5 tests.

- [x] **Step 5: Run them with the rest of the suite**

In the root `package.json`, change `test` to:

```json
    "test": "npm run test --workspaces --if-present && node --test \"scripts/*.test.mjs\"",
```

The glob is quoted so Node expands it (Node 22+), not the shell. That works the same in `cmd` on Windows and in `sh` on CI.

Run: `npm test`
Expected: every workspace passes, then the 5 script tests.

- [x] **Step 6: Commit**

```bash
git add scripts/check-tag-version.mjs scripts/check-tag-version.test.mjs package.json
git commit -m "build: add the release tag/version check script"
```

---

### Task 3: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_call:

permissions:
  contents: read

jobs:
  check:
    name: Build, typecheck, lint, test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm run lint
      # Server tests start Postgres with testcontainers on the runner's Docker.
      - run: npm test

  image:
    name: Build server image (amd64, not pushed)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: server/Dockerfile
          platforms: linux/amd64
          push: false
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Lint the workflow locally**

If `actionlint` is installed, run `actionlint` from the repo root. Expected: no findings. If it isn't, skip this step. Step 4's real run is the check.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build, typecheck, lint and test every push; build the server image"
git push origin main
```

Pushing to `main` is what triggers the workflow. Confirm with the user before pushing.

- [ ] **Step 4: Watch the run**

Run: `gh run watch --exit-status $(gh run list --workflow ci.yml --limit 1 --json databaseId -q '.[0].databaseId')`
Expected: both jobs succeed. If `npm ci` fails on a missing Linux native optional dependency (Tailwind's oxide, Rollup, esbuild), the lockfile lacks that platform's entry. Regenerate the entries with `npm install --os=linux --cpu=x64` and commit the lockfile. If anything else fails, fix it before Task 4. Release workflows call this one.

---

### Task 4: Client release workflow

**Files:**
- Create: `.github/workflows/release-js.yml`
- Modify: `packages/js/package.json`

- [ ] **Step 1: Build before every pack**

In `packages/js/package.json`, add to `scripts`:

```json
    "prepack": "npm run build",
```

`npm publish` and `npm pack` run `prepack`, so a publish, including the manual first one, can't ship a stale or missing `dist/`.

- [ ] **Step 2: Check the packed contents**

Run: `npm pack --dry-run -w @tripcord/js`
Expected: the build runs, then the file list is `LICENSE`, `README.md`, `package.json` and files under `dist/`, and nothing else (no `src/`, no test files, no `tsup.config.ts`).

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/release-js.yml`:

```yaml
name: Release @tripcord/js

on:
  push:
    tags: ["js-v*"]

permissions:
  contents: read

jobs:
  tag:
    name: Tag matches packages/js version
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: node scripts/check-tag-version.mjs "$GITHUB_REF_NAME" packages/js/package.json

  ci:
    uses: ./.github/workflows/ci.yml

  publish:
    name: Publish to npm
    needs: [tag, ci]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # npm trusted publishing (OIDC) and provenance
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
          registry-url: https://registry.npmjs.org
      # Trusted publishing needs npm 11.5.1+, newer than the npm bundled with Node 22.
      - run: npm install -g npm@^11.5.1
      - id: published
        name: Skip versions already on npm
        run: |
          version=$(node -p "require('./packages/js/package.json').version")
          if npm view "@tripcord/js@$version" version >/dev/null 2>&1; then
            echo "@tripcord/js@$version is already published; nothing to do."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi
      - if: steps.published.outputs.skip != 'true'
        run: npm ci
      # prepack builds dist/; publishConfig sets access=public and provenance.
      - if: steps.published.outputs.skip != 'true'
        run: npm publish -w @tripcord/js
```

The skip step makes the workflow safe to re-run, and it lets `js-v0.2.0`, which is published by hand, be tagged without a red run.

The tag check is its own job, running in parallel with CI rather than after it, so a bad tag fails in seconds. `publish` needs both, so a mismatch still stops the release before `npm publish`, as the spec requires.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-js.yml packages/js/package.json
git commit -m "ci: release @tripcord/js from js-v* tags with npm trusted publishing"
```

This workflow isn't exercised until `0.2.1`. `0.2.0` is published by hand (see `docs/releasing.md`, Task 6).

---

### Task 5: Server release workflow and multi-arch Dockerfile

**Files:**
- Create: `.github/workflows/release-server.yml`
- Modify: `server/Dockerfile`

- [ ] **Step 1: Build the dashboard natively**

In `server/Dockerfile`, change the first stage and extend its comment:

```dockerfile
# The dashboard is built on Debian: Tailwind v4's native binary is resolved for
# the platform the lockfile was generated on (glibc), which alpine (musl) may lack.
# Its output is static files, so it builds once on the build machine's platform,
# whatever the target. That also avoids resolving Tailwind's binary under QEMU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS dashboard-build
```

The `build` and `runtime` stages stay per-platform.

- [ ] **Step 2: Build both platforms locally**

```bash
docker buildx build --platform linux/amd64,linux/arm64 -f server/Dockerfile .
```

Expected: both platforms build, and the log shows `dashboard-build` once. If the local builder refuses multi-platform builds, run `docker buildx create --use --name tripcord` first.

Then load and check the arm64 image:

```bash
docker buildx build --platform linux/arm64 -f server/Dockerfile -t tripcord:arm64-test --load .
docker run --rm --platform linux/arm64 tripcord:arm64-test sh -c "uname -m && node -p \"require('/app/server/dist/version.js').SERVER_VERSION\""
```

Expected: `aarch64`, then `0.1.0`.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/release-server.yml`:

```yaml
name: Release server image

on:
  push:
    tags: ["server-v*"]

permissions:
  contents: read

jobs:
  tag:
    name: Tag matches server version
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: node scripts/check-tag-version.mjs "$GITHUB_REF_NAME" server/package.json

  ci:
    uses: ./.github/workflows/ci.yml

  image:
    name: Build and push ghcr.io/jonaszbigda/tripcord
    needs: [tag, ci]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/jonaszbigda/tripcord
          flavor: latest=false
          # server-v1.2.3 → 1.2.3, 1.2, latest
          tags: |
            type=match,pattern=server-v(\d+\.\d+\.\d+),group=1
            type=match,pattern=server-v(\d+\.\d+)\.\d+,group=1
            type=raw,value=latest
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: server/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          # Includes org.opencontainers.image.source, which links the GHCR package to the repo.
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-server.yml server/Dockerfile
git commit -m "ci: release the server image to GHCR for amd64 and arm64 from server-v* tags"
```

The first real run is `server-v0.1.0`, in Task 7.

---

### Task 6: Self-hosting guide, deploy compose, release checklist, READMEs

**Files:**
- Create: `deploy/docker-compose.yml`, `deploy/.env.example`, `docs/self-hosting.md`, `docs/releasing.md`
- Modify: `README.md`, `server/README.md`, `packages/js/README.md`, `docs/superpowers/specs/2026-09-22-repro-client-library-design.md`

- [ ] **Step 1: The deploy compose file**

Create `deploy/docker-compose.yml`:

```yaml
# Runs a released Tripcord server and its Postgres. See docs/self-hosting.md.
# For development from source, use the docker-compose.yml at the repo root.
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: tripcord
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: tripcord
    volumes:
      - tripcord-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tripcord"]
      interval: 5s
      timeout: 5s
      retries: 5

  server:
    image: ghcr.io/jonaszbigda/tripcord:${TRIPCORD_VERSION:-0.1}
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://tripcord:${POSTGRES_PASSWORD}@postgres:5432/tripcord
      PUBLIC_URL: ${PUBLIC_URL:?Set PUBLIC_URL in .env}
      SIGNUP: ${SIGNUP:-invite-only}
      TRUST_PROXY: ${TRUST_PROXY:-false}
      RETENTION_DAYS: ${RETENTION_DAYS:-30}
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:-}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:-}
    ports:
      # Only reachable from this machine; put a reverse proxy in front for HTTPS.
      - "127.0.0.1:3000:3000"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  tripcord-postgres-data:
```

Empty `GITHUB_CLIENT_*` values count as unset in `server/src/config.ts`, so GitHub login stays off until both are filled in.

Create `deploy/.env.example`:

```bash
# Copy to .env next to docker-compose.yml.
# Generate with: openssl rand -hex 32  (hex keeps it safe inside DATABASE_URL)
POSTGRES_PASSWORD=
# The URL people open the dashboard at, e.g. https://tripcord.example.com
PUBLIC_URL=
# Pin a minor version; see "Upgrading" in docs/self-hosting.md
TRIPCORD_VERSION=0.1
# invite-only (default) or open
SIGNUP=invite-only
# true when running behind a reverse proxy
TRUST_PROXY=true
RETENTION_DAYS=30
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

- [ ] **Step 2: `docs/self-hosting.md`**

Write the guide with these sections. Keep it task-shaped: commands first, then only as much explanation as the operator needs.

1. **Requirements:** a Linux host with Docker and Compose v2, amd64 or arm64. A domain name for HTTPS.
2. **Running:** download `deploy/docker-compose.yml` and `deploy/.env.example` (raw GitHub URLs from `main`), `cp .env.example .env`, generate `POSTGRES_PASSWORD` with `openssl rand -hex 32`, set `PUBLIC_URL`, then `docker compose up -d` and `curl -s localhost:3000/health`, which should print `{"status":"ok","version":"0.1.x"}`.
3. **First account:** open `PUBLIC_URL`. The first signup is open to exactly one person, who becomes the first org owner. Then `SIGNUP=invite-only` (invite links from the Members page) vs `open`. Do the first signup right after starting, before the URL is shared.
4. **HTTPS:** the server listens on `127.0.0.1:3000` only. Caddy example:

   ```caddyfile
   tripcord.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```

   With a proxy in front, set `TRUST_PROXY=true` so login and invalid-key rate limits see client IPs, not the proxy's. Set it only when every request comes through the proxy. `PUBLIC_URL` must be the `https://` URL, which also makes cookies `Secure`.
5. **GitHub login:** the OAuth app steps, with callback `<PUBLIC_URL>/api/auth/github/callback`, then fill in both `GITHUB_CLIENT_*` values and `docker compose up -d`.
6. **Configuration:** every variable is documented in `server/README.md` → "Environment variables". Anything not in `deploy/docker-compose.yml` can be added to the `server` service's `environment`.
7. **Upgrading:** `TRIPCORD_VERSION` pins a minor (`0.1`), which picks up patch releases. `docker compose pull && docker compose up -d`. Migrations run on start behind a Postgres advisory lock, so a restart applies them once. Confirm with `/health`'s `version`. Moving to a new minor means changing `TRIPCORD_VERSION` after reading the release notes. Back up first.
8. **Backups:**

   ```bash
   docker compose exec -T postgres pg_dump -U tripcord -Fc tripcord > tripcord-$(date +%F).dump
   docker compose exec -T postgres pg_restore -U tripcord -d tripcord --clean --if-exists < tripcord-2026-09-24.dump
   ```

   Note that the retention job already deletes timelines older than `RETENTION_DAYS`, so a backup holds at most that window of timelines.
9. **Connecting the client:** `npm i @tripcord/js`, create a project and key in the dashboard, then `init({ endpoint: "${PUBLIC_URL}/v1/timeline", apiKey })`. Link to `packages/js/README.md`.
10. **Admin CLI:** `docker compose exec server node server/dist/cli.js --help` for recovery (e.g. `user reset-password`). Link to `server/README.md` → "The admin CLI".

- [ ] **Step 3: `docs/releasing.md`**

```markdown
# Releasing

`@tripcord/js` and the server image are versioned independently and released from
git tags: `js-vX.Y.Z` publishes the client to npm, `server-vX.Y.Z` pushes
`ghcr.io/jonaszbigda/tripcord`. Both workflows run the full CI first and refuse a
tag whose version doesn't match the package's `package.json`.

## One-time setup

Done by the maintainer, with their npm and GitHub accounts.

1. ~~Rename the GitHub repository to `jonaszbigda/tripcord`.~~ Done 2026-09-24.
2. Publish `@tripcord/js@0.2.0` by hand. npm can only set up a trusted publisher
   for a package that already exists, and provenance can only be generated in CI:

   ```bash
   npm login
   npm publish -w @tripcord/js --provenance=false
   ```

   Then tag that commit `js-v0.2.0` and push the tag. The release workflow sees
   the version is already on npm and skips publishing. The tag marks what was
   published.
3. On npmjs.com → `@tripcord/js` → Settings → Trusted publishing, add GitHub
   Actions: owner `jonaszbigda`, repository `tripcord`, workflow `release-js.yml`,
   no environment. Then, under Publishing access, require 2FA and disallow tokens.
4. After the first server release (`server-v0.1.0`), open the package on GitHub
   (Profile → Packages → tripcord → Package settings) and change its visibility to
   public. Until then `docker pull` needs a login.

## Each release

1. Bump `version` in `packages/js/package.json` or `server/package.json`, and run
   `npm install` so `package-lock.json` matches.
2. If a client feature needs a newer server, add a row to the compatibility table
   in `packages/js/README.md`.
3. Commit, then tag and push:

   ```bash
   git tag js-v0.2.1        # or server-v0.1.1
   git push origin main js-v0.2.1
   ```

4. Watch the run: `gh run watch`. When it's done, check
   `npm view @tripcord/js version`, or `docker pull ghcr.io/jonaszbigda/tripcord:0.1`
   and `/health`.

A failed run can be re-run from the Actions tab. The client workflow skips a
version that's already on npm. If the fix needs a new commit, delete the tag, then
tag the fixed commit and push it again. npm never allows re-publishing a version,
so a client release that reached npm needs a new version number.
```

- [ ] **Step 4: READMEs**

`packages/js/README.md`:
- In "## Status", rewrite the lists to match reality: the ingest server, dashboard and self-host Docker packaging are built. Hosted SaaS and the SSR/Node adapter aren't. Remove the "Publishing to npm — not on the registry yet" bullet. Update the stale "(50 tests)" count or drop it.
- Add an "## Install" section before "## Quick start":

  ~~~markdown
  ## Install

  ```bash
  npm i @tripcord/js
  ```

  You need a Tripcord server to send timelines to. See
  [Self-hosting](https://github.com/jonaszbigda/tripcord/blob/main/docs/self-hosting.md).
  ~~~

- In "Quick start", change the `endpoint` comment to point at `${PUBLIC_URL}/v1/timeline` on your server.
- Add a "### Server compatibility" section after "### Page URLs", with the spec's table and the sentence: "The server always accepts older clients' payloads: the ingest schema only ever gains optional fields."

Links in this README must be absolute GitHub URLs, because it's rendered on npmjs.com, where relative links break.

`README.md` (root): in "## Packages", change "not yet published to npm" to "published as `@tripcord/js`" and the server line to point at [`docs/self-hosting.md`](docs/self-hosting.md) for running it. Add a line linking to [`docs/releasing.md`](docs/releasing.md) under "## Development".

`server/README.md`: at the top of "## Running it", add: "To run a released version in production, see [`docs/self-hosting.md`](../docs/self-hosting.md). This section covers running from source."

`docs/superpowers/specs/2026-09-22-repro-client-library-design.md`: under the `Scope:` line, add:

```markdown
> Renamed 2026-09-24: the product is now Tripcord and the package `@tripcord/js`
> (see `2026-09-23-repro-release-design.md`). This spec keeps the old names.
```

- [ ] **Step 5: Check the deploy compose file parses**

Run: `POSTGRES_PASSWORD=x PUBLIC_URL=http://localhost:3000 docker compose -f deploy/docker-compose.yml config --quiet`
Expected: no output, exit 0. Without the variables, `docker compose -f deploy/docker-compose.yml config` fails with "Set POSTGRES_PASSWORD in .env".

- [ ] **Step 6: Verify the whole repo**

Run: `npm run build && npm run typecheck && npm run lint && npm test`
Expected: everything passes. Record the test counts per workspace plus the script tests.

- [ ] **Step 7: Commit**

```bash
git add deploy docs/self-hosting.md docs/releasing.md README.md server/README.md packages/js/README.md docs/superpowers/specs/2026-09-22-repro-client-library-design.md
git commit -m "docs: self-hosting guide, deploy compose file and release checklist"
```

---

### Task 7: First releases (with the user)

Every step here publishes something or needs the user's accounts. Do each one only after the user says to.

- [ ] **Step 1: Push and confirm CI is green** on the commits from Tasks 4–6.

- [ ] **Step 2: Publish `@tripcord/js@0.2.0` by hand.** The user runs `npm login` and `npm publish -w @tripcord/js --provenance=false` (suggest the `!` prefix). Then `npm view @tripcord/js version` should print `0.2.0`. Tag the published commit: `git tag js-v0.2.0 && git push origin js-v0.2.0`. The release workflow runs and skips the publish step.

- [ ] **Step 3: Configure the npm trusted publisher.** The user does this on npmjs.com, as in `docs/releasing.md`.

- [ ] **Step 4: Release the server.** `git tag server-v0.1.0 && git push origin server-v0.1.0`, then `gh run watch`. Expected: the tag, CI and image jobs pass. The package page lists `0.1.0`, `0.1` and `latest`, linked to the repository. The user makes the package public.

- [ ] **Step 5: Manual checks from the spec.**
  - In a clean scratchpad directory: `npm init -y && npm i @tripcord/js react`, then `node -e "import('@tripcord/js').then(m => console.log(Object.keys(m)))"` and the same for `@tripcord/js/react`. Both list their exports.
  - Anonymously (`docker logout ghcr.io` first): `docker pull --platform linux/arm64 ghcr.io/jonaszbigda/tripcord:0.1` and `docker image inspect` shows `"Architecture": "arm64"`.
  - In a scratchpad copy of `deploy/` with a filled-in `.env` (`PUBLIC_URL=http://localhost:3000`): `docker compose up -d`, then `curl -s localhost:3000/health` prints `{"status":"ok","version":"0.1.0"}`. Tear down with `docker compose down -v`.

- [ ] **Step 6: Mark the spec done.** Add a note at the end of the spec's "## Testing" section recording the date, the published versions and the results of Step 5. Commit: `docs: record the first Tripcord releases`.

Dogfooding (the spec's checklist) starts here and isn't part of this plan.
