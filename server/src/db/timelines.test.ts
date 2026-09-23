import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, insertTestTimeline, pgTimestampAgo, resetDb } from "../../test/db";
import {
  decodeCursor,
  encodeCursor,
  getTimeline,
  listTags,
  listTimelines,
  summarizeTimelines,
  type Cursor,
  type Range,
  type TimelineFilters,
} from "./timelines";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ALL: TimelineFilters = { range: "30d", reasonTypes: [], tags: [] };
const PAGE = { limit: 50 };

async function newProject(): Promise<string> {
  return (await createTestProject(getTestDb())).project.id;
}

/** Epoch ms of a pgTimestampAgo() value (UTC wall-clock text). */
function epochOf(pgTimestamp: string): number {
  return Date.parse(`${pgTimestamp.replace(" ", "T")}Z`);
}

describe("timeline read service", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  describe("listTimelines", () => {
    it("lists newest first within the range", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const recent = await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(2 * HOUR) });
      const days = await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(3 * DAY) });
      const old = await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(10 * DAY) });

      const ids = async (range: Range) =>
        (await listTimelines(db, projectId, { ...ALL, range }, PAGE)).timelines.map((t) => t.id);
      expect(await ids("24h")).toEqual([recent]);
      expect(await ids("7d")).toEqual([recent, days]);
      expect(await ids("30d")).toEqual([recent, days, old]);
    });

    it("never returns another project's timelines", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      const mine = await insertTestTimeline(db, projectId);
      await insertTestTimeline(db, otherId);

      const result = await listTimelines(db, projectId, ALL, PAGE);
      expect(result.timelines.map((t) => t.id)).toEqual([mine]);
    });

    it("filters by reason type", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestTimeline(db, projectId, { reason: { type: "error", message: "e" } });
      const manual = await insertTestTimeline(db, projectId, { reason: { type: "manual", name: "m" } });
      const rejection = await insertTestTimeline(db, projectId, { reason: { type: "unhandledrejection", message: "r" } });

      const result = await listTimelines(db, projectId, { ...ALL, reasonTypes: ["manual", "unhandledrejection"] }, PAGE);
      expect(new Set(result.timelines.map((t) => t.id))).toEqual(new Set([manual, rejection]));
    });

    it("matches any of the selected tags", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const checkout = await insertTestTimeline(db, projectId, { tags: ["checkout"] });
      const video = await insertTestTimeline(db, projectId, { tags: ["video_player"] });
      const both = await insertTestTimeline(db, projectId, { tags: ["checkout", "payments"] });
      await insertTestTimeline(db, projectId, { tags: [] });

      const ids = async (tags: string[]) =>
        new Set((await listTimelines(db, projectId, { ...ALL, tags }, PAGE)).timelines.map((t) => t.id));
      expect(await ids(["checkout", "payments"])).toEqual(new Set([checkout, both]));
      expect(await ids(["video_player", "payments"])).toEqual(new Set([video, both]));
    });

    it("returns the list fields: µs ISO time, a 300-character message, the url and the event count", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const id = await insertTestTimeline(db, projectId, {
        reason: { type: "error", name: "TypeError", message: "m".repeat(500) },
        events: [{ timestamp: 1, type: "custom", name: "a" }, { timestamp: 2, type: "custom", name: "b" }, { timestamp: 3, type: "trace", name: "c" }],
        tags: ["checkout"],
        url: "https://shop.example.com/cart?step=2",
      });

      const [row] = (await listTimelines(db, projectId, ALL, PAGE)).timelines;
      expect(row).toEqual({
        id,
        receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
        sessionId: "session-1",
        reasonType: "error",
        reasonName: "TypeError",
        reasonMessage: "m".repeat(300),
        url: "https://shop.example.com/cart?step=2",
        tags: ["checkout"],
        eventCount: 3,
      });
    });

    it("pages through rows that differ only in microseconds, each exactly once", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const base = pgTimestampAgo(HOUR); // millisecond precision: "…:02.123"
      const inserted: string[] = [];
      for (const micros of ["456", "457", "458"]) {
        inserted.push(await insertTestTimeline(db, projectId, { receivedAt: `${base}${micros}` }));
      }

      const seen: string[] = [];
      let cursor: Cursor | undefined;
      for (let i = 0; i < 4; i++) {
        const result = await listTimelines(db, projectId, ALL, { limit: 1, cursor });
        seen.push(...result.timelines.map((t) => t.id));
        if (!result.nextCursor) break;
        cursor = decodeCursor(result.nextCursor);
      }
      expect(seen).toEqual([...inserted].reverse());
    });
  });

  describe("cursor", () => {
    it("round-trips", () => {
      const cursor = { receivedAt: "2026-09-23T10:15:02.123456Z", id: "3b241101-e2bb-4255-8caf-4136c566a962" };
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it.each([
      "",
      "garbage",
      Buffer.from("2026-09-23T10:15:02.123456Z|not-a-uuid").toString("base64url"),
      Buffer.from("yesterday|3b241101-e2bb-4255-8caf-4136c566a962").toString("base64url"),
      Buffer.from("2026-09-23T10:15:02.123456Z|3b241101-e2bb-4255-8caf-4136c566a962|x").toString("base64url"),
    ])("rejects %j", (value) => {
      expect(decodeCursor(value)).toBeUndefined();
    });
  });

  describe("summarizeTimelines", () => {
    it("fills 25 hourly buckets for 24h and splits counts by reason type", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const anHourAgo = pgTimestampAgo(HOUR);
      await insertTestTimeline(db, projectId, { receivedAt: anHourAgo });
      await insertTestTimeline(db, projectId, { receivedAt: anHourAgo });
      await insertTestTimeline(db, projectId, { receivedAt: anHourAgo, reason: { type: "manual", name: "m" } });
      await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(5 * HOUR), reason: { type: "unhandledrejection" } });

      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "24h" }, "UTC");

      expect(summary.bucket).toBe("hour");
      expect(summary.buckets).toHaveLength(25);
      summary.buckets.forEach((b) => expect(b.start).toMatch(/T\d{2}:00:00\.000Z$/));
      const at = epochOf(anHourAgo);
      const holding = summary.buckets.find((b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + HOUR);
      expect(holding).toMatchObject({ error: 2, manual: 1, unhandledrejection: 0 });
      const total = (key: "error" | "manual" | "unhandledrejection") => summary.buckets.reduce((sum, b) => sum + b[key], 0);
      expect([total("error"), total("manual"), total("unhandledrejection")]).toEqual([2, 1, 1]);
    });

    it("fills 8 daily buckets for 7d", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(3 * DAY) });

      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "7d" }, "UTC");

      expect(summary.bucket).toBe("day");
      expect(summary.buckets).toHaveLength(8);
      summary.buckets.forEach((b) => expect(b.start).toMatch(/T00:00:00\.000Z$/));
      expect(summary.buckets.reduce((sum, b) => sum + b.error, 0)).toBe(1);
    });

    it("cuts days at the viewer's midnight", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      // 20:00 UTC two days ago is 01:30 the next day in Kolkata, so a bucket cut
      // at UTC midnight would put it on the wrong day whatever the time is now.
      const twoDaysAgo = new Date(Date.now() - 2 * DAY);
      twoDaysAgo.setUTCHours(20, 0, 0, 0);
      const receivedAt = twoDaysAgo.toISOString().replace("T", " ").replace("Z", "");
      await insertTestTimeline(db, projectId, { receivedAt });

      // Asia/Kolkata is UTC+05:30 with no DST, so local midnight is always 18:30Z.
      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "7d" }, "Asia/Kolkata");

      summary.buckets.forEach((b) => expect(b.start).toMatch(/T18:30:00\.000Z$/));
      const at = epochOf(receivedAt);
      const holding = summary.buckets.find((b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + DAY);
      expect(holding?.error).toBe(1);
    });

    it("ranks top reasons by count and truncates their messages", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      for (let i = 0; i < 3; i++) {
        await insertTestTimeline(db, projectId, { reason: { type: "error", name: "TypeError", message: "a" } });
      }
      for (let i = 0; i < 2; i++) {
        await insertTestTimeline(db, projectId, { reason: { type: "manual", name: "payment-declined" } });
      }
      await insertTestTimeline(db, projectId, { reason: { type: "error", message: "x".repeat(400) } });

      const { topReasons } = await summarizeTimelines(db, projectId, ALL, "UTC");

      expect(topReasons.map((r) => [r.type, r.name, r.count])).toEqual([
        ["error", "TypeError", 3],
        ["manual", "payment-declined", 2],
        ["error", null, 1],
      ]);
      expect(topReasons[1].message).toBeNull();
      expect(topReasons[2].message).toBe("x".repeat(300));
      expect(topReasons[0].key).toMatch(/^[0-9a-f]{32}$/);
      expect(topReasons[0].lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });

    it("feeds a top-reason key back into the list filter, including a group with no name", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      for (let i = 0; i < 2; i++) {
        await insertTestTimeline(db, projectId, { reason: { type: "error", name: "TypeError", message: "a" } });
      }
      const nameless = await insertTestTimeline(db, projectId, { reason: { type: "error", message: "a" } });

      const { topReasons } = await summarizeTimelines(db, projectId, ALL, "UTC");
      const namelessKey = topReasons.find((r) => r.name === null)?.key;
      const typeErrorKey = topReasons.find((r) => r.name === "TypeError")?.key;

      const list = async (reason: string | undefined) => (await listTimelines(db, projectId, { ...ALL, reason }, PAGE)).timelines;
      expect((await list(namelessKey)).map((t) => t.id)).toEqual([nameless]);
      expect(await list(typeErrorKey)).toHaveLength(2);
      expect(await list("0".repeat(32))).toEqual([]);
    });

    it("applies the filters to buckets and top reasons", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestTimeline(db, projectId, { tags: ["checkout"] });
      await insertTestTimeline(db, projectId, { tags: ["video_player"] });

      const summary = await summarizeTimelines(db, projectId, { ...ALL, tags: ["checkout"] }, "UTC");

      expect(summary.buckets.reduce((sum, b) => sum + b.error, 0)).toBe(1);
      expect(summary.topReasons.map((r) => r.count)).toEqual([1]);
    });

    it("reports projectHasTimelines regardless of the filters", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      expect((await summarizeTimelines(db, projectId, ALL, "UTC")).projectHasTimelines).toBe(false);

      await insertTestTimeline(db, projectId, { receivedAt: pgTimestampAgo(10 * DAY) });
      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "24h" }, "UTC");
      expect(summary.projectHasTimelines).toBe(true);
      expect(summary.buckets.every((b) => b.error + b.manual + b.unhandledrejection === 0)).toBe(true);
    });
  });

  describe("listTags", () => {
    it("counts the range's tags, most used first, for this project only", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      await insertTestTimeline(db, projectId, { tags: ["checkout", "payments"] });
      await insertTestTimeline(db, projectId, { tags: ["checkout"] });
      await insertTestTimeline(db, projectId, { tags: ["video_player"], receivedAt: pgTimestampAgo(3 * DAY) });
      await insertTestTimeline(db, otherId, { tags: ["elsewhere"] });

      expect(await listTags(db, projectId, "7d")).toEqual([
        { tag: "checkout", count: 2 },
        { tag: "payments", count: 1 },
        { tag: "video_player", count: 1 },
      ]);
      expect((await listTags(db, projectId, "24h")).map((t) => t.tag)).toEqual(["checkout", "payments"]);
    });
  });

  describe("getTimeline", () => {
    it("returns the whole timeline and its siblings from the same session and project", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      const first = await insertTestTimeline(db, projectId, { sessionId: "s1", receivedAt: pgTimestampAgo(3 * HOUR), reason: { type: "manual", name: "earlier" } });
      const id = await insertTestTimeline(db, projectId, { sessionId: "s1", tags: ["checkout"], receivedAt: pgTimestampAgo(2 * HOUR) });
      const later = await insertTestTimeline(db, projectId, { sessionId: "s1", receivedAt: pgTimestampAgo(HOUR) });
      await insertTestTimeline(db, projectId, { sessionId: "s2" });
      await insertTestTimeline(db, otherId, { sessionId: "s1" });

      const found = await getTimeline(db, projectId, id);

      expect(found?.timeline).toMatchObject({
        id,
        sessionId: "s1",
        tags: ["checkout"],
        reason: { type: "error", name: "TypeError", message: "boom" },
        events: [{ timestamp: 1, type: "custom", name: "step" }],
        meta: { url: "https://shop.example.com/checkout", userAgent: "test-agent", capturedAt: 1 },
      });
      expect(found?.siblings.map((s) => s.id)).toEqual([first, later]);
      expect(found?.siblings[0]).toMatchObject({ reasonType: "manual", reasonName: "earlier" });
    });

    it("returns undefined for a timeline in another project", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      const theirs = await insertTestTimeline(db, otherId);
      expect(await getTimeline(db, projectId, theirs)).toBeUndefined();
    });
  });
});
