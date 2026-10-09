import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TimelineEvent, TimelineMeta } from "@tripcord/js";
import { createTestProject, getTestDb, resetDb } from "../../test/db";
import type { Database } from "./client";
import { captures, timelineSessions, type TimelineSession } from "./schema";
import {
  bakeCapture,
  ensureTimelineSession,
  MAX_SESSION_EVENTS,
  pruneTimelineSessions,
  stageEvents,
} from "./timeline-sessions";

const HOUR = 60 * 60 * 1000;

const event = (over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  timestamp: 1,
  type: "custom",
  name: "step",
  ...over,
});

const meta = (): TimelineMeta => ({ url: "https://shop.example.com/checkout", userAgent: "test-agent", capturedAt: 1 });

async function sessionRow(db: Database, projectId: string, sessionId: string): Promise<TimelineSession | undefined> {
  const [row] = await db
    .select()
    .from(timelineSessions)
    .where(and(eq(timelineSessions.projectId, projectId), eq(timelineSessions.sessionId, sessionId)));
  return row;
}

const bake = (db: Database, projectId: string, sessionId: string, events: TimelineEvent[] = []) =>
  bakeCapture(db, projectId, {
    sessionId,
    reason: { type: "manual", name: "boom" },
    events,
    meta: meta(),
    tags: [],
    occurredAt: new Date(),
  });

describe("timeline-session service", () => {
  let db: Database;
  let projectId: string;

  beforeEach(async () => {
    db = getTestDb();
    await resetDb(db);
    projectId = (await createTestProject(db)).project.id;
  });

  it("stages without baking", async () => {
    await stageEvents(db, projectId, "s1", [event({ id: "a", timestamp: 1 })]);
    const row = await sessionRow(db, projectId, "s1");
    expect(row).toMatchObject({ events: [] });
    expect(row?.pendingEvents).toHaveLength(1);
  });

  it("defaults a staged event's source to server", async () => {
    await stageEvents(db, projectId, "s1", [event({ id: "a" })]);
    const row = await sessionRow(db, projectId, "s1");
    expect((row?.pendingEvents as TimelineEvent[])[0].source).toBe("server");
  });

  it("appends to the staging buffer across calls", async () => {
    await stageEvents(db, projectId, "s1", [event({ id: "a", timestamp: 1 })]);
    await stageEvents(db, projectId, "s1", [event({ id: "b", timestamp: 2 })]);
    const row = await sessionRow(db, projectId, "s1");
    expect((row?.pendingEvents as TimelineEvent[]).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("bakes staged + payload events, deduped and sorted, and clears the buffer", async () => {
    await stageEvents(db, projectId, "s1", [event({ id: "staged", timestamp: 0 })]);
    const { eventCount } = await bake(db, projectId, "s1", [event({ id: "payload", timestamp: 1 })]);

    expect(eventCount).toBe(2);
    const row = await sessionRow(db, projectId, "s1");
    expect((row?.events as TimelineEvent[]).map((e) => e.id)).toEqual(["staged", "payload"]);
    expect(row?.pendingEvents).toEqual([]);
  });

  it("records a capture with the reason, meta, tags and occurred time", async () => {
    const occurredAt = new Date();
    await bakeCapture(db, projectId, {
      sessionId: "s1",
      reason: { type: "error", name: "TypeError", message: "boom" },
      events: [],
      meta: meta(),
      tags: ["checkout"],
      occurredAt,
    });
    const [capture] = await db.select().from(captures).where(eq(captures.sessionId, "s1"));
    expect(capture).toMatchObject({
      projectId,
      reasonType: "error",
      reason: { type: "error", name: "TypeError", message: "boom" },
      tags: ["checkout"],
    });
    expect(capture.occurredAt.getTime()).toBe(occurredAt.getTime());
  });

  it("two captures in one session don't duplicate the browser buffer", async () => {
    const buffer = [event({ id: "a", timestamp: 1 }), event({ id: "b", timestamp: 2 })];
    await bake(db, projectId, "s1", buffer);
    await bake(db, projectId, "s1", buffer);
    expect((await sessionRow(db, projectId, "s1"))?.events).toHaveLength(2);
  });

  it("dedupes content-identical events that have no id", async () => {
    const buffer = [event({ timestamp: 1, name: "same" })];
    await bake(db, projectId, "s1", buffer);
    await bake(db, projectId, "s1", buffer);
    expect((await sessionRow(db, projectId, "s1"))?.events).toHaveLength(1);
  });

  it("keeps staging per project for the same session id", async () => {
    const otherId = (await createTestProject(db, "other")).project.id;
    await stageEvents(db, projectId, "s1", [event({ id: "a" })]);
    await stageEvents(db, otherId, "s1", [event({ id: "b" })]);
    expect((await sessionRow(db, projectId, "s1"))?.pendingEvents).toHaveLength(1);
    expect((await sessionRow(db, otherId, "s1"))?.pendingEvents).toHaveLength(1);
  });

  it("caps a session's timeline at MAX_SESSION_EVENTS, dropping the oldest", async () => {
    const events = Array.from({ length: MAX_SESSION_EVENTS + 2 }, (_, i) =>
      event({ id: `e${i}`, timestamp: i })
    );
    const { eventCount } = await bake(db, projectId, "s1", events);
    expect(eventCount).toBe(MAX_SESSION_EVENTS);
    const baked = (await sessionRow(db, projectId, "s1"))?.events as TimelineEvent[];
    expect(baked).toHaveLength(MAX_SESSION_EVENTS);
    expect(baked[0].id).toBe("e2");
    expect(baked[baked.length - 1].id).toBe(`e${MAX_SESSION_EVENTS + 1}`);
  });

  it("prunes idle sessions but leaves their captures", async () => {
    await bake(db, projectId, "s1");
    await db
      .update(timelineSessions)
      .set({ updatedAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(timelineSessions.sessionId, "s1"));

    expect(await pruneTimelineSessions(db, HOUR)).toBe(1);
    expect(await sessionRow(db, projectId, "s1")).toBeUndefined();
    expect(await db.select().from(captures).where(eq(captures.sessionId, "s1"))).toHaveLength(1);
  });

  it("keeps a recently updated session", async () => {
    await stageEvents(db, projectId, "s1", [event({ id: "a" })]);
    expect(await pruneTimelineSessions(db, HOUR)).toBe(0);
    expect(await sessionRow(db, projectId, "s1")).toBeDefined();
  });

  it("ensureTimelineSession creates an empty session idempotently", async () => {
    await ensureTimelineSession(db, projectId, "s1");
    await ensureTimelineSession(db, projectId, "s1");
    const rows = await db.select().from(timelineSessions).where(eq(timelineSessions.sessionId, "s1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].events).toEqual([]);
  });
});
