import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb } from "../../test/db";
import { projects, timelines } from "../db/schema";
import { buildApp } from "../app";

const validPayload = {
  sessionId: "session-1",
  reason: { type: "manual", name: "payment-declined", data: { code: "insufficient_funds" } },
  events: [{ timestamp: 1, type: "custom", name: "checkout.step" }],
  meta: { url: "https://example.com/checkout", userAgent: "test-agent", capturedAt: 1700000000000 },
};

describe("POST /v1/timeline", () => {
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(timelines);
    await db.delete(projects);
  });

  it("returns 401 when the X-Repro-Key header is missing", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({ method: "POST", url: "/v1/timeline", payload: validPayload });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Missing X-Repro-Key header" });
  });

  it("returns 401 when the api key doesn't match any project", async () => {
    const app = await buildApp(getTestDb(), { rateLimitMax: 1000, rateLimitWindow: "1 minute" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "no-such-key" },
      payload: validPayload,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid API key" });
  });

  it("returns 400 for a malformed body, without inserting anything", async () => {
    const db = getTestDb();
    await db.insert(projects).values({ name: "acme", apiKey: "key-valid" });
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: { sessionId: "session-1" }, // missing reason/events/meta
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: expect.any(String) });
    const rows = await db.select().from(timelines);
    expect(rows).toHaveLength(0);
  });

  it("returns 400 and inserts nothing for a payload with an unknown extra field, instead of silently stripping it", async () => {
    const db = getTestDb();
    await db.insert(projects).values({ name: "acme", apiKey: "key-valid" });
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
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
      headers: { "x-repro-key": "no-such-key" },
      payload: { totally: "wrong shape" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("stores a valid payload and returns 201 with an id", async () => {
    const db = getTestDb();
    const [project] = await db.insert(projects).values({ name: "acme", apiKey: "key-valid" }).returning();
    const app = await buildApp(db, { rateLimitMax: 1000, rateLimitWindow: "1 minute" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
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
});

describe("POST /v1/timeline rate limiting", () => {
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(timelines);
    await db.delete(projects);
  });

  it("returns 429 after exceeding the per-project limit", async () => {
    const db = getTestDb();
    await db.insert(projects).values({ name: "acme", apiKey: "key-valid" });
    const app = await buildApp(db, { rateLimitMax: 2, rateLimitWindow: "1 minute" });

    const first = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: validPayload,
    });
    const third = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-repro-key": "key-valid" },
      payload: validPayload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: expect.any(String) });
  });
});
