import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, insertTestTimeline, pgTimestampAgo, resetDb } from "../../test/db";
import { exportTimelines } from "./timelines";

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const row of rows) all.push(row);
  return all;
}

describe("exportTimelines", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("yields every timeline once, oldest first, across batches and equal timestamps", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const other = await createTestProject(db, "other", project.orgId);
    const same = pgTimestampAgo(60_000);
    const ids = [
      await insertTestTimeline(db, project.id, { receivedAt: pgTimestampAgo(120_000) }),
      await insertTestTimeline(db, project.id, { receivedAt: same }),
      await insertTestTimeline(db, project.id, { receivedAt: same }),
      await insertTestTimeline(db, project.id, { receivedAt: same }),
      await insertTestTimeline(db, project.id, { receivedAt: pgTimestampAgo(1_000) }),
    ];
    await insertTestTimeline(db, other.project.id);

    const rows = await collect(exportTimelines(db, project.id, 2));

    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
    expect(rows[0].id).toBe(ids[0]);
    expect(rows[4].id).toBe(ids[4]);
    expect(rows[0]).toEqual({
      id: ids[0],
      receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
      sessionId: "session-1",
      reasonType: "error",
      reason: { type: "error", name: "TypeError", message: "boom" },
      events: [{ timestamp: 1, type: "custom", name: "step" }],
      meta: { url: "https://shop.example.com/checkout", userAgent: "test-agent", capturedAt: 1 },
      tags: [],
    });
  });

  it("yields nothing for a project without timelines", async () => {
    const { project } = await createTestProject(getTestDb());
    expect(await collect(exportTimelines(getTestDb(), project.id))).toEqual([]);
  });
});
