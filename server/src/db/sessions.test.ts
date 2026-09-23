import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestUser, getTestDb, resetDb } from "../../test/db";
import { hashToken } from "../auth/tokens";
import { sessions } from "./schema";
import {
  SESSION_TTL_MS,
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  findSessionUser,
} from "./sessions";

describe("sessions", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates a 30-day session and resolves its token to the user", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const before = Date.now();

    const { token, expiresAt } = await createSession(db, user.id);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect((await findSessionUser(db, token))?.id).toBe(user.id);
  });

  it("stores only the token hash", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const { token } = await createSession(db, user.id);

    const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it("does not resolve unknown or expired tokens", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await db
      .insert(sessions)
      .values({ tokenHash: hashToken("expired"), userId: user.id, expiresAt: new Date(Date.now() - 1000) });

    expect(await findSessionUser(db, "unknown")).toBeUndefined();
    expect(await findSessionUser(db, "expired")).toBeUndefined();
  });

  it("deletes one session", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const { token } = await createSession(db, user.id);

    await deleteSession(db, token);

    expect(await findSessionUser(db, token)).toBeUndefined();
  });

  it("deletes all of a user's sessions, optionally keeping one", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const other = await createTestUser(db);
    const a = await createSession(db, user.id);
    const b = await createSession(db, user.id);
    const c = await createSession(db, other.id);

    await deleteUserSessions(db, user.id, { except: a.token });
    expect(await findSessionUser(db, a.token)).toBeDefined();
    expect(await findSessionUser(db, b.token)).toBeUndefined();

    await deleteUserSessions(db, user.id);
    expect(await findSessionUser(db, a.token)).toBeUndefined();
    expect(await findSessionUser(db, c.token)).toBeDefined();
  });

  it("deletes expired sessions only", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const live = await createSession(db, user.id);
    await db
      .insert(sessions)
      .values({ tokenHash: hashToken("old"), userId: user.id, expiresAt: new Date(Date.now() - 1000) });

    expect(await deleteExpiredSessions(db)).toBe(1);
    expect(await findSessionUser(db, live.token)).toBeDefined();
  });
});
