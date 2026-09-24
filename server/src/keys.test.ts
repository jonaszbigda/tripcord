import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "./keys";

describe("generateApiKey", () => {
  it("produces an tpk_-prefixed key of 43 base64url characters (47 total)", () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^tpk_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(47);
  });

  it("uses the first 12 characters of the key as the display prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(prefix).toHaveLength(12);
    expect(prefix).toBe(key.slice(0, 12));
  });

  it("returns the SHA-256 hash of the key", () => {
    const { key, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(key));
  });

  it("generates a different key each call", () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first.key).not.toBe(second.key);
    expect(first.hash).not.toBe(second.hash);
  });
});

describe("hashApiKey", () => {
  it("returns lowercase hex SHA-256", () => {
    // Known SHA-256 test vector for "abc".
    expect(hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is deterministic and differs for different inputs", () => {
    expect(hashApiKey("tpk_same")).toBe(hashApiKey("tpk_same"));
    expect(hashApiKey("tpk_one")).not.toBe(hashApiKey("tpk_two"));
  });
});
