import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, getTestDb, resetDb } from "../../test/db";
import { apiKeys, timelines } from "../db/schema";
import { hashApiKey } from "../keys";
import { buildApp } from "../app";

const validPayload = {
  sessionId: "session-1",
  reason: { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
  events: [{ timestamp: 1, type: "custom", name: "checkout.step" }],
  meta: { url: "https://example.com/checkout", userAgent: "test-agent", capturedAt: 1700000000000 },
};

describe("POST /v1/timeline", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns 401 when the X-Tripcord-Key header is missing", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({ method: "POST", url: "/v1/timeline", payload: validPayload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Missing X-Tripcord-Key header" });
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
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
  });

  it("returns 400 and inserts nothing for a payload with an unknown extra field, instead of silently stripping it", async () => {
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
    expect(response.json()).toEqual({ error: expect.any(String) });
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
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

  it("stores a valid payload and returns 201 with an id", async () => {
    const db = getTestDb();
    const { project, key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: validPayload,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBeTypeOf("string");

    const [row] = await db.select().from(timelines);
    expect(row.projectId).toBe(project.id);
    expect(row.sessionId).toBe("session-1");
    expect(row.reasonType).toBe("manual");
    expect(row.reason).toEqual(validPayload.reason);
    expect(row.events).toEqual(validPayload.events);
    expect(row.meta).toEqual(validPayload.meta);
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
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
  });

  it("stores tags, and {} when the payload has none", async () => {
    const db = getTestDb();
    const { key } = await createTestProject(db);
    const app = await buildApp(db, { rateLimitMax: 1000, logLevel: "silent" });

    for (const payload of [{ ...validPayload, tags: ["checkout", "payments"] }, validPayload]) {
      const response = await app.inject({ method: "POST", url: "/v1/timeline", headers: { "x-tripcord-key": key }, payload });
      expect(response.statusCode).toBe(201);
    }

    const rows = await db.select({ tags: timelines.tags }).from(timelines);
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
    expect(await db.select().from(timelines)).toHaveLength(0);
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

    const first = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: validPayload,
    });
    const third = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key },
      payload: validPayload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: expect.any(String) });
  });
});
