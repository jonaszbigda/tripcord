import { createHash, randomBytes } from "node:crypto";

export interface GeneratedToken {
  /** Plaintext — handed to the client once, never stored. */
  token: string;
  /** What gets stored. */
  hash: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// 32 random bytes: high-entropy, so a fast hash is the right choice for storage
// (same reasoning as API keys in keys.ts).
export function generateToken(prefix = ""): GeneratedToken {
  const token = prefix + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}
