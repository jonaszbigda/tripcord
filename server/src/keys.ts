import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "rpk_";
const KEY_RANDOM_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = 12;

export interface GeneratedApiKey {
  /** The plaintext key. Shown to the user once, never stored. */
  key: string;
  /** First 12 characters of `key`, stored for display. */
  prefix: string;
  /** SHA-256 of `key`, lowercase hex. The only form stored. */
  hash: string;
}

// Keys are 256-bit random values, so a fast hash is the right tool: there's no
// low-entropy secret for a slow password hash (bcrypt/argon2) to protect, and a
// fast hash keeps ingest auth to a single indexed equality lookup.
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const key = KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString("base64url");
  return { key, prefix: key.slice(0, DISPLAY_PREFIX_LENGTH), hash: hashApiKey(key) };
}
