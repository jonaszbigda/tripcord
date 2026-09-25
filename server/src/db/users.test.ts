import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestUser, getTestDb, resetDb } from "../../test/db";
import { users } from "./schema";
import {
  countUsers,
  findUserByEmail,
  findUserByGithubId,
  findUserById,
  insertUser,
  listUnverifiedUserIds,
  markEmailVerified,
  normalizeEmail,
  setUnverifiedEmail,
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

  it("stores emailVerifiedAt when given, and NULL by default", async () => {
    const db = getTestDb();
    const at = new Date("2026-09-24T10:00:00Z");
    const verified = await insertUser(db, { email: "v@example.com", name: "V", passwordHash: null, githubId: null, emailVerifiedAt: at });
    const plain = await insertUser(db, { email: "p@example.com", name: "P", passwordHash: null, githubId: null });
    expect(verified.emailVerifiedAt).toEqual(at);
    expect(plain.emailVerifiedAt).toBeNull();
  });

  it("markEmailVerified sets the time once and never moves it", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { emailVerified: false });
    const first = new Date("2026-09-24T10:00:00Z");
    await markEmailVerified(db, user.id, first);
    await markEmailVerified(db, user.id, new Date("2026-09-25T10:00:00Z"));
    expect((await findUserById(db, user.id))?.emailVerifiedAt).toEqual(first);
  });

  it("setUnverifiedEmail stores the normalized address, but never a verified user's", async () => {
    const db = getTestDb();
    const unverified = await createTestUser(db, { emailVerified: false });
    const verified = await createTestUser(db);

    expect(await setUnverifiedEmail(db, unverified.id, " New@Example.com ")).toBe(true);
    expect(await setUnverifiedEmail(db, verified.id, "other@example.com")).toBe(false);

    expect((await findUserById(db, unverified.id))?.email).toBe("new@example.com");
    expect((await findUserById(db, verified.id))?.email).toBe(verified.email);
  });

  it("lists unverified users created before a cutoff", async () => {
    const db = getTestDb();
    const old = await createTestUser(db, { emailVerified: false });
    const recent = await createTestUser(db, { emailVerified: false });
    await createTestUser(db); // verified
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(users.id, old.id));

    const ids = await listUnverifiedUserIds(db, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

    expect(ids).toEqual([old.id]);
    expect(ids).not.toContain(recent.id);
  });
});
