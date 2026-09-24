import { describe, it, expect } from "vitest";
import { generatePassword, generateToken, hashToken } from "./tokens";

describe("generateToken", () => {
  it("returns 43 base64url characters and their SHA-256", () => {
    const { token, hash } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prepends the prefix", () => {
    expect(generateToken("tpi_").token).toMatch(/^tpi_[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", () => {
    expect(generateToken().token).not.toBe(generateToken().token);
  });
});

describe("hashToken", () => {
  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("generatePassword", () => {
  it("returns 24 base64url characters", () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(generatePassword()).not.toBe(generatePassword());
  });
});
