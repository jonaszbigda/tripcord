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
