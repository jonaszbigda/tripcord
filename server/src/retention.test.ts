import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, resetDb, createTestUser } from "../test/db";
import { timelines, users } from "./db/schema";
import { cleanupOldTimelines, runCleanup } from "./retention";
import { findUserById } from "./db/users";
import { eq } from "drizzle-orm";

describe("cleanupOldTimelines", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes timelines older than the retention window and keeps recent ones", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);

    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000); // 40 days ago
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    await db.insert(timelines).values([
      {
        projectId: project.id,
        sessionId: "old-session",
        reasonType: "manual",
        reason: { type: "manual" },
        events: [],
        meta: { url: "https://example.com", userAgent: "test", capturedAt: old.getTime() },
        receivedAt: old,
      },
      {
        projectId: project.id,
        sessionId: "recent-session",
        reasonType: "manual",
        reason: { type: "manual" },
        events: [],
        meta: { url: "https://example.com", userAgent: "test", capturedAt: recent.getTime() },
        receivedAt: recent,
      },
    ]);

    const deletedCount = await cleanupOldTimelines(db, 30);

    expect(deletedCount).toBe(1);
    const remaining = await db.select().from(timelines);
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
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(users.id, user.id));
    return user;
  }

  it("deletes stale unverified accounts while verification is active", async () => {
    const user = await staleUnverifiedUser();
    await runCleanup(getTestDb(), 30, true);
    expect(await findUserById(getTestDb(), user.id)).toBeUndefined();
  });

  it("keeps them when verification is off (review focus 4)", async () => {
    const user = await staleUnverifiedUser();
    await runCleanup(getTestDb(), 30, false);
    expect(await findUserById(getTestDb(), user.id)).toBeDefined();
  });
});
