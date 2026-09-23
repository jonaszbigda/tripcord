import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb } from "../../test/db";
import {
  countUsers,
  findUserByEmail,
  findUserByGithubId,
  findUserById,
  insertUser,
  normalizeEmail,
  setGithubId,
  setPasswordHash,
} from "./users";

describe("users", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("normalizes emails by trimming and lowercasing", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });

  it("stores the normalized email and finds the user case-insensitively", async () => {
    const db = getTestDb();
    const user = await insertUser(db, { email: " Ana@Example.com", name: "Ana", passwordHash: null, githubId: null });

    expect(user.email).toBe("ana@example.com");
    expect((await findUserByEmail(db, "ANA@example.com "))?.id).toBe(user.id);
    expect((await findUserById(db, user.id))?.email).toBe("ana@example.com");
  });

  it("rejects a second user with the same email", async () => {
    const db = getTestDb();
    await insertUser(db, { email: "a@example.com", name: "A", passwordHash: null, githubId: null });
    await expect(
      insertUser(db, { email: "A@example.com", name: "B", passwordHash: null, githubId: null })
    ).rejects.toThrow();
  });

  it("counts users", async () => {
    const db = getTestDb();
    expect(await countUsers(db)).toBe(0);
    await createTestUser(db);
    await createTestUser(db);
    expect(await countUsers(db)).toBe(2);
  });

  it("sets and clears the GitHub id", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);

    await setGithubId(db, user.id, "12345");
    expect((await findUserByGithubId(db, "12345"))?.id).toBe(user.id);

    await setGithubId(db, user.id, null);
    expect(await findUserByGithubId(db, "12345")).toBeUndefined();
  });

  it("sets the password hash", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await setPasswordHash(db, user.id, "scrypt$fake");
    expect((await findUserById(db, user.id))?.passwordHash).toBe("scrypt$fake");
  });
});
