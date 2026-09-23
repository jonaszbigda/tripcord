import { describe, it, expect } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from "./password";

describe("hashPassword / verifyPassword", () => {
  it("produces a self-describing scrypt hash", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("correct horsE", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("honors the cost parameters encoded in the hash", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("pw-at-low-cost", salt, 64, { N: 1024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("pw-at-low-cost", stored)).toBe(true);
  });

  it.each([["nope"], ["bcrypt$1$2$3$4$5"], ["scrypt$x$8$1$abc$def"], ["scrypt$1024$8$1$abc$"]])(
    "returns false for a malformed hash %s",
    async (stored) => {
      expect(await verifyPassword("anything", stored)).toBe(false);
    }
  );
});

describe("verifyPasswordOrDummy", () => {
  it("returns false when there is no stored hash", async () => {
    expect(await verifyPasswordOrDummy("anything", null)).toBe(false);
  });

  it("verifies against a real hash when one is given", async () => {
    const hash = await hashPassword("secret-pw");
    expect(await verifyPasswordOrDummy("secret-pw", hash)).toBe(true);
  });
});
