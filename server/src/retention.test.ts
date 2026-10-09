import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { TimelineMeta } from "@tripcord/js";
import { createTestProject, getTestDb, resetDb, createTestUser } from "../test/db";
import { captures, timelineSessions, users } from "./db/schema";
import { bakeCapture } from "./db/timeline-sessions";
import { cleanupOldCaptures, runCleanup } from "./retention";
import { findUserById } from "./db/users";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const meta = (): TimelineMeta => ({ url: "https://example.com", userAgent: "test", capturedAt: 1 });

describe("cleanupOldCaptures", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes captures older than the retention window and keeps recent ones", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);

    const old = new Date(Date.now() - 40 * DAY);
    const recent = new Date(Date.now() - 1 * DAY);

    await db.insert(captures).values([
      { projectId: project.id, sessionId: "old-session", reasonType: "manual", reason: { type: "manual" }, meta: meta(), occurredAt: old, receivedAt: old },
      { projectId: project.id, sessionId: "recent-session", reasonType: "manual", reason: { type: "manual" }, meta: meta(), occurredAt: recent, receivedAt: recent },
    ]);

    expect(await cleanupOldCaptures(db, 30)).toBe(1);
    const remaining = await db.select().from(captures);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sessionId).toBe("recent-session");
  });
});

describe("runCleanup", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  async function staleUnverifiedUser() {
    const db = getTestDb();
    const user = await createTestUser(db, { emailVerified: false });
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(users.id, user.id));
    return user;
  }

  it("prunes idle sessions and keeps recently active ones, leaving captures alone", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    await bakeCapture(db, project.id, { sessionId: "old", reason: { type: "manual" }, events: [], meta: meta(), tags: [], occurredAt: new Date() });
    await bakeCapture(db, project.id, { sessionId: "recent", reason: { type: "manual" }, events: [], meta: meta(), tags: [], occurredAt: new Date() });
    await db.update(timelineSessions).set({ updatedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(timelineSessions.sessionId, "old"));

    await runCleanup(db, 30, false, HOUR);

    const sessions = await db.select().from(timelineSessions);
    expect(sessions.map((s) => s.sessionId)).toEqual(["recent"]);
    // Both captures survive their sessions.
    expect(await db.select().from(captures)).toHaveLength(2);
  });

  it("deletes stale unverified accounts while verification is active", async () => {
    const user = await staleUnverifiedUser();
    await runCleanup(getTestDb(), 30, true, HOUR);
    expect(await findUserById(getTestDb(), user.id)).toBeUndefined();
  });

  it("still deletes them when another step fails, then reports the failure", async () => {
    const user = await staleUnverifiedUser();
    // NaN makes an invalid cutoff date, so the capture step rejects.
    const error = await runCleanup(getTestDb(), NaN, true, HOUR).catch((reason: unknown) => reason);
    expect(await findUserById(getTestDb(), user.id)).toBeUndefined();
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(1);
  });

  it("keeps them when verification is off", async () => {
    const user = await staleUnverifiedUser();
    await runCleanup(getTestDb(), 30, false, HOUR);
    expect(await findUserById(getTestDb(), user.id)).toBeDefined();
  });
});
