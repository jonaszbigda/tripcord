import { readFileSync } from "node:fs";
import path from "node:path";

// src/version.ts (tests) and dist/version.js (built, and in the Docker image)
// both sit one level below server/package.json.
export const SERVER_VERSION: string = (
  JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string }
).version;
