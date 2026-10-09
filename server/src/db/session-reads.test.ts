import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, insertTestCapture, pgTimestampAgo, resetDb } from "../../test/db";
import {
  decodeCursor,
  encodeCursor,
  getSession,
  listSessions,
  listTags,
  summarizeTimelines,
  type Range,
  type SessionCursor,
  type TimelineFilters,
} from "./session-reads";

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

describe("session read service", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  describe("listSessions", () => {
    it("lists one row per session, newest activity first, within the range", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestCapture(db, projectId, { sessionId: "recent", receivedAt: pgTimestampAgo(2 * HOUR) });
      await insertTestCapture(db, projectId, { sessionId: "days", receivedAt: pgTimestampAgo(3 * DAY) });
      await insertTestCapture(db, projectId, { sessionId: "old", receivedAt: pgTimestampAgo(10 * DAY) });

      const ids = async (range: Range) =>
        (await listSessions(db, projectId, { ...ALL, range }, PAGE)).sessions.map((s) => s.sessionId);
      expect(await ids("24h")).toEqual(["recent"]);
      expect(await ids("7d")).toEqual(["recent", "days"]);
      expect(await ids("30d")).toEqual(["recent", "days", "old"]);
    });

    it("never returns another project's sessions", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      await insertTestCapture(db, projectId, { sessionId: "mine" });
      await insertTestCapture(db, otherId, { sessionId: "theirs" });

      expect((await listSessions(db, projectId, ALL, PAGE)).sessions.map((s) => s.sessionId)).toEqual(["mine"]);
    });

    it("aggregates a session's captures: count, reason types, and the union of tags", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestCapture(db, projectId, { sessionId: "s1", tags: ["checkout"], reason: { type: "error", name: "TypeError", message: "boom" } });
      await insertTestCapture(db, projectId, { sessionId: "s1", tags: ["checkout", "payments"], reason: { type: "manual", name: "m" } });

      const [row] = (await listSessions(db, projectId, ALL, PAGE)).sessions;
      expect(row).toMatchObject({
        sessionId: "s1",
        captureCount: 2,
        tags: ["checkout", "payments"],
      });
      expect([...row.reasonTypes].sort()).toEqual(["error", "manual"]);
      expect(row.url).toBe("https://shop.example.com/checkout");
    });

    it("counts the session's baked events", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestCapture(db, projectId, {
        sessionId: "s1",
        events: [
          { timestamp: 1, type: "custom", name: "a" },
          { timestamp: 2, type: "custom", name: "b" },
        ],
      });

      const [row] = (await listSessions(db, projectId, ALL, PAGE)).sessions;
      expect(row.eventCount).toBe(2);
    });

    it("filters by reason type across a session's captures", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestCapture(db, projectId, { sessionId: "errors", reason: { type: "error", message: "e" } });
      await insertTestCapture(db, projectId, { sessionId: "manual", reason: { type: "manual", name: "m" } });

      const result = await listSessions(db, projectId, { ...ALL, reasonTypes: ["manual"] }, PAGE);
      expect(result.sessions.map((s) => s.sessionId)).toEqual(["manual"]);
    });

    it("matches any of the selected tags", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestCapture(db, projectId, { sessionId: "checkout", tags: ["checkout"] });
      await insertTestCapture(db, projectId, { sessionId: "video", tags: ["video_player"] });
      await insertTestCapture(db, projectId, { sessionId: "both", tags: ["checkout", "payments"] });
      await insertTestCapture(db, projectId, { sessionId: "none", tags: [] });

      const ids = async (tags: string[]) =>
        (await listSessions(db, projectId, { ...ALL, tags }, PAGE)).sessions.map((s) => s.sessionId).sort();
      expect(await ids(["checkout", "payments"])).toEqual(["both", "checkout"]);
      expect(await ids(["video_player", "payments"])).toEqual(["both", "video"]);
    });

    it("keyset-pages sessions, each exactly once", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const base = pgTimestampAgo(HOUR);
      const inserted = [
        await insertTestCapture(db, projectId, { sessionId: "a", receivedAt: `${base}456` }),
        await insertTestCapture(db, projectId, { sessionId: "b", receivedAt: `${base}457` }),
        await insertTestCapture(db, projectId, { sessionId: "c", receivedAt: `${base}458` }),
      ];
      void inserted;

      const seen: string[] = [];
      let cursor: SessionCursor | undefined;
      for (let i = 0; i < 5; i++) {
        const result = await listSessions(db, projectId, ALL, { limit: 1, cursor });
        seen.push(...result.sessions.map((s) => s.sessionId));
        if (!result.nextCursor) break;
        cursor = decodeCursor(result.nextCursor);
      }
      expect(seen).toEqual(["c", "b", "a"]);
    });
  });

  describe("cursor", () => {
    it("round-trips, including a session id with a pipe in it", () => {
      const cursor = { lastSeenAt: "2026-09-23T10:15:02.123456Z", sessionId: "a|b|c" };
      expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    });

    it.each([
      "",
      "garbage",
      Buffer.from(JSON.stringify({ lastSeenAt: "yesterday", sessionId: "s" })).toString("base64url"),
      Buffer.from(JSON.stringify({ lastSeenAt: "2026-09-23T10:15:02.123456Z" })).toString("base64url"),
      Buffer.from(JSON.stringify({ lastSeenAt: "2026-09-23T10:15:02.123456Z", sessionId: "" })).toString("base64url"),
      Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url"),
    ])("rejects %j", (value) => {
      expect(decodeCursor(value)).toBeUndefined();
    });
  });

  describe("getSession", () => {
    it("returns the session's events and its captures, oldest first", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const otherId = await newProject();
      const events = [{ timestamp: 9, type: "custom", name: "baked" }];
      await insertTestCapture(db, projectId, { sessionId: "s1", receivedAt: pgTimestampAgo(3 * HOUR), reason: { type: "manual", name: "earlier" } });
      await insertTestCapture(db, projectId, { sessionId: "s1", tags: ["checkout"], receivedAt: pgTimestampAgo(2 * HOUR), events });
      await insertTestCapture(db, projectId, { sessionId: "s1", receivedAt: pgTimestampAgo(HOUR), events });
      await insertTestCapture(db, projectId, { sessionId: "s2" });
      await insertTestCapture(db, otherId, { sessionId: "s1" });

      const found = await getSession(db, projectId, "s1");

      expect(found?.session).toMatchObject({ sessionId: "s1", tags: ["checkout"], events });
      expect(found?.captures.map((c) => c.reasonType)).toEqual(["manual", "error", "error"]);
      expect(found?.captures[0].reason).toEqual({ type: "manual", name: "earlier" });
    });

    it("returns undefined for a session with no captures", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      expect(await getSession(db, projectId, "missing")).toBeUndefined();
    });
  });

  describe("summarizeTimelines", () => {
    it("fills 25 hourly buckets for 24h and splits counts by reason type", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const anHourAgo = pgTimestampAgo(HOUR);
      await insertTestCapture(db, projectId, { sessionId: "a", receivedAt: anHourAgo });
      await insertTestCapture(db, projectId, { sessionId: "b", receivedAt: anHourAgo });
      await insertTestCapture(db, projectId, { sessionId: "c", receivedAt: anHourAgo, reason: { type: "manual", name: "m" } });
      await insertTestCapture(db, projectId, { sessionId: "d", receivedAt: pgTimestampAgo(5 * HOUR), reason: { type: "unhandledrejection" } });

      const summary = await summarizeTimelines(db, projectId, { ...ALL, range: "24h" }, "UTC");

      expect(summary.bucket).toBe("hour");
      expect(summary.buckets).toHaveLength(25);
      const at = epochOf(anHourAgo);
      const holding = summary.buckets.find((b) => at >= Date.parse(b.start) && at < Date.parse(b.start) + HOUR);
      expect(holding).toMatchObject({ error: 2, manual: 1, unhandledrejection: 0 });
    });

    it("cuts days at the viewer's midnight", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      const twoDaysAgo = new Date(Date.now() - 2 * DAY);
      twoDaysAgo.setUTCHours(20, 0, 0, 0);
      const receivedAt = twoDaysAgo.toISOString().replace("T", " ").replace("Z", "");
      await insertTestCapture(db, projectId, { sessionId: "a", receivedAt });

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
        await insertTestCapture(db, projectId, { sessionId: `e${i}`, reason: { type: "error", name: "TypeError", message: "a" } });
      }
      for (let i = 0; i < 2; i++) {
        await insertTestCapture(db, projectId, { sessionId: `m${i}`, reason: { type: "manual", name: "payment-declined" } });
      }
      await insertTestCapture(db, projectId, { sessionId: "long", reason: { type: "error", message: "x".repeat(400) } });

      const { topReasons } = await summarizeTimelines(db, projectId, ALL, "UTC");
      expect(topReasons.map((r) => [r.type, r.name, r.count])).toEqual([
        ["error", "TypeError", 3],
        ["manual", "payment-declined", 2],
        ["error", null, 1],
      ]);
      expect(topReasons[2].message).toBe("x".repeat(300));
    });

    it("feeds a top-reason key back into the session list filter", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      await insertTestCapture(db, projectId, { sessionId: "s1", reason: { type: "error", name: "TypeError", message: "a" } });
      await insertTestCapture(db, projectId, { sessionId: "s2", reason: { type: "error", name: "TypeError", message: "a" } });
      await insertTestCapture(db, projectId, { sessionId: "s3", reason: { type: "error", message: "a" } });

      const { topReasons } = await summarizeTimelines(db, projectId, ALL, "UTC");
      const namelessKey = topReasons.find((r) => r.name === null)?.key;
      const typeErrorKey = topReasons.find((r) => r.name === "TypeError")?.key;

      const list = async (reason: string | undefined) =>
        (await listSessions(db, projectId, { ...ALL, reason }, PAGE)).sessions.map((s) => s.sessionId).sort();
      expect(await list(namelessKey)).toEqual(["s3"]);
      expect(await list(typeErrorKey)).toEqual(["s1", "s2"]);
    });

    it("reports projectHasTimelines regardless of the filters", async () => {
      const db = getTestDb();
      const projectId = await newProject();
      expect((await summarizeTimelines(db, projectId, ALL, "UTC")).projectHasTimelines).toBe(false);

      await insertTestCapture(db, projectId, { sessionId: "a", receivedAt: pgTimestampAgo(10 * DAY) });
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
      await insertTestCapture(db, projectId, { sessionId: "a", tags: ["checkout", "payments"] });
      await insertTestCapture(db, projectId, { sessionId: "b", tags: ["checkout"] });
      await insertTestCapture(db, projectId, { sessionId: "c", tags: ["video_player"], receivedAt: pgTimestampAgo(3 * DAY) });
      await insertTestCapture(db, otherId, { sessionId: "d", tags: ["elsewhere"] });

      expect(await listTags(db, projectId, "7d")).toEqual([
        { tag: "checkout", count: 2 },
        { tag: "payments", count: 1 },
        { tag: "video_player", count: 1 },
      ]);
      expect((await listTags(db, projectId, "24h")).map((t) => t.tag)).toEqual(["checkout", "payments"]);
    });
  });
});
