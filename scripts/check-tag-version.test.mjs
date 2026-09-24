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
