import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, resetDb } from "../test/db";
import { timelines } from "./db/schema";
import { cleanupOldTimelines } from "./retention";

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
