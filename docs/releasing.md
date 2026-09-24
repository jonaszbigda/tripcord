# Releasing

`@tripcord/js` and the server image are versioned independently and released from
git tags:

- `js-vX.Y.Z` publishes `@tripcord/js` to npm (`.github/workflows/release-js.yml`).
- `server-vX.Y.Z` pushes `ghcr.io/jonaszbigda/tripcord` for amd64 and arm64, tagged
  `X.Y.Z`, `X.Y` and `latest` (`.github/workflows/release-server.yml`).

Both workflows run the full CI first and refuse a tag whose version doesn't match
the package's `package.json` (`scripts/check-tag-version.mjs`).

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

4. Watch the run with `gh run watch`. When it's done, check
   `npm view @tripcord/js version`, or pull `ghcr.io/jonaszbigda/tripcord:0.1` and
   check `/health`.

A failed run can be re-run from the Actions tab. The client workflow skips a
version that's already on npm. If the fix needs a new commit, delete the tag
(`git push origin :refs/tags/js-v0.2.1`), then tag the fixed commit and push it
again. npm never allows re-publishing a version, so a client release that reached
npm needs a new version number.
