import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { TimelineEvent } from "@tripcord/js";
import { createTestProject, getTestDb, resetDb } from "../../test/db";
import { apiKeys, captures, timelineSessions } from "../db/schema";
import { stageEvents } from "../db/timeline-sessions";
import { hashApiKey } from "../keys";
import { buildApp } from "../app";

const validPayload = {
  sessionId: "session-1",
  reason: { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
  events: [{ timestamp: 1, type: "custom", name: "checkout.step" }],
  meta: { url: "https://example.com/checkout", userAgent: "test-agent", capturedAt: 1700000000000 },
};

async function sessionEvents(db: ReturnType<typeof getTestDb>, sessionId = "session-1"): Promise<TimelineEvent[]> {
  const [row] = await db.select().from(timelineSessions).where(eq(timelineSessions.sessionId, sessionId));
  return (row?.events as TimelineEvent[]) ?? [];
}

describe("POST /v1/timeline", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns 401 when no API key header is present", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({ method: "POST", url: "/v1/timeline", payload: validPayload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Missing API key" });
  });

  it("returns 401 when the api key doesn't match any project", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": "no-such-key" },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid API key" });
  });

  it("returns 400 for a malformed body, without inserting anything", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: { sessionId: "session-1" }, // missing reason/events/meta
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
    expect(await db.select().from(captures)).toHaveLength(0);
  });

  it("returns 400 and inserts nothing for a payload with an unknown extra field", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: { ...validPayload, futureField: "should be rejected, not stripped" },
    });

    expect(response.statusCode).toBe(400);
    expect(await db.select().from(captures)).toHaveLength(0);
  });

  it("returns 401 for an unknown api key even with a malformed body, proving auth runs before validation", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": "no-such-key" },
      payload: { totally: "wrong shape" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("accepts the key as Authorization: Bearer", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { authorization: `Bearer ${key}` },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
  });

  it("records a capture and bakes the browser's events", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ sessionId: "session-1", eventCount: 1 });
    expect(body.id).toBeTypeOf("string");

    const [row] = await db.select().from(captures);
    expect(row.projectId).toBe(project.id);
    expect(row.sessionId).toBe("session-1");
    expect(row.reasonType).toBe("manual");
    expect(row.reason).toEqual(validPayload.reason);
    expect(row.meta).toEqual(validPayload.meta);

    // The browser's event is stamped source "browser".
    expect(await sessionEvents(db)).toEqual([{ ...validPayload.events[0], source: "browser" }]);
  });

  it("bakes staged server events together with the browser's, ordered by time", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db);
    await stageEvents(db, project.id, "session-1", [
      { timestamp: 0, type: "custom", name: "server.step", source: "server" },
    ]);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    await app.inject({ method: "POST", url: "/v1/timeline", headers: { "x-tripcord-key": key }, payload: validPayload });

    expect((await sessionEvents(db)).map((event) => event.name)).toEqual(["server.step", "checkout.step"]);
  });

  it("returns the same 401 for a revoked key as for an unknown key", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.keyHash, hashApiKey(key)));
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid API key" });
    expect(await db.select().from(captures)).toHaveLength(0);
  });

  it("stores tags, and {} when the payload has none", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    for (const payload of [{ ...validPayload, tags: ["checkout", "payments"] }, validPayload]) {
      const response = await app.inject({ method: "POST", url: "/v1/timeline", headers: { "x-tripcord-key": key }, payload });
      expect(response.statusCode).toBe(201);
    }

    const rows = await db.select({ tags: captures.tags }).from(captures);
    expect(rows.map((row) => row.tags).sort((a, b) => b.length - a.length)).toEqual([["checkout", "payments"], []]);
  });

  it.each([
    ["an uppercase tag", ["Checkout"]],
    ["a tag with a space", ["check out"]],
    ["a 51-character tag", ["x".repeat(51)]],
    ["a duplicate", ["checkout", "checkout"]],
    ["11 tags", Array.from({ length: 11 }, (_, i) => `t${i}`)],
  ])("returns 400 and stores nothing for %s", async (_label, tags) => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: { ...validPayload, tags },
    });

    expect(response.statusCode).toBe(400);
    expect(await db.select().from(captures)).toHaveLength(0);
  });
});

describe("POST /v1/events", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  const staged = {
    sessionId: "session-1",
    events: [{ timestamp: 1, type: "custom", name: "job.started" }],
  };

  it("stages events without recording a capture", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    const response = await app.inject({ method: "POST", url: "/v1/events", headers: { "x-tripcord-key": key }, payload: staged });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ sessionId: "session-1", staged: 1 });
    expect(await db.select().from(captures)).toHaveLength(0);

    const [session] = await db.select().from(timelineSessions);
    expect(session.projectId).toBe(project.id);
    // Defaulted to source "server".
    expect(session.pendingEvents).toEqual([{ ...staged.events[0], source: "server" }]);
  });

  it("requires a key and a non-empty events array", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    expect((await app.inject({ method: "POST", url: "/v1/events", payload: staged })).statusCode).toBe(401);
    const empty = await app.inject({ method: "POST", url: "/v1/events", headers: { "x-tripcord-key": key }, payload: { sessionId: "s", events: [] } });
    expect(empty.statusCode).toBe(400);
  });
});

describe("POST /v1/sessions", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("mints a session id", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    const response = await app.inject({ method: "POST", url: "/v1/sessions", headers: { "authorization": `Bearer ${key}` }, payload: {} });

    expect(response.statusCode).toBe(201);
    expect(response.json().sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.select().from(timelineSessions)).toHaveLength(1);
  });
});

describe("POST /v1/timeline invalid-key limiting", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  function post(app: Awaited<ReturnType<typeof buildApp>>, key: string, remoteAddress = "203.0.113.1") {
    return app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: validPayload,
      remoteAddress,
    });
  }

  it("returns 429 to an IP past the invalid-key limit, before looking the key up", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, invalidKeyLimitMax: 2 });

    expect((await post(app, "no-such-key")).statusCode).toBe(401);
    expect((await post(app, "no-such-key")).statusCode).toBe(401);
    const blocked = await post(app, "no-such-key");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: expect.stringMatching(/^Too many invalid API key attempts, retry in \d+ seconds$/) });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // Blocked before the lookup, so even a valid key from that IP is turned away.
    expect((await post(app, key)).statusCode).toBe(429);
    expect((await post(app, key, "203.0.113.2")).statusCode).toBe(201);
  });

  it("shares the invalid-key limit across ingest routes", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, invalidKeyLimitMax: 1 });

    // One bad key on /events exhausts the IP's budget for /timeline too.
    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { "x-tripcord-key": "no-such-key" },
      payload: { sessionId: "s", events: [{ timestamp: 1, type: "custom", name: "x" }] },
      remoteAddress: "203.0.113.1",
    });
    expect((await post(app, key)).statusCode).toBe(429);
  });

  it("doesn't count requests with a valid key", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, invalidKeyLimitMax: 1 });

    expect((await post(app, key)).statusCode).toBe(201);
    expect((await post(app, key)).statusCode).toBe(201);
    expect((await post(app, "no-such-key")).statusCode).toBe(401);
  });
});

describe("POST /v1/timeline rate limiting", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns 429 after exceeding the per-project limit", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 2, rateLimitWindow: "1 minute" });

    const call = () =>
      app.inject({ method: "POST", url: "/v1/timeline", headers: { "x-tripcord-key": key }, payload: validPayload });

    expect((await call()).statusCode).toBe(201);
    expect((await call()).statusCode).toBe(201);
    const third = await call();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: expect.any(String) });
  });
});
