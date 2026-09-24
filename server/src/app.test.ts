import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createTestProject, createTestUser, getTestDb, resetDb, sessionCookie } from "../test/db";
import { TEST_ORIGIN, call } from "../test/http";
import { buildApp } from "./app";

describe("GET /health", () => {
  it("returns 200 with status ok and the version from server/package.json", async () => {
    const { version } = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    const app = await buildApp(getTestDb());
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version });
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("CORS", () => {
  it("responds to an OPTIONS preflight for /v1/timeline with 2xx/204 and allows the X-Tripcord-Key header", async () => {
    const app = await buildApp(getTestDb());
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/timeline",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-tripcord-key",
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);

    // HTTP headers are case-insensitive and Fastify normalizes to lowercase,
    // so check case-insensitively rather than assuming the exact casing the
    // browser client sends ("X-Tripcord-Key").
    const allowHeaders = String(response.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowHeaders).toContain("x-tripcord-key");
  });
});

describe("404", () => {
  it("returns { error: 'Not Found' } for an unregistered route", async () => {
    const app = await buildApp(getTestDb());
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found" });
  });
});

describe("CORS scope", () => {
  it("sends no CORS headers on /api routes", async () => {
    const app = await buildApp(getTestDb());
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/me",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();

    const get = await app.inject({ method: "GET", url: "/api/auth/config", headers: { origin: "https://evil.example" } });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still allows any origin on /v1/timeline", async () => {
    await resetDb(getTestDb());
    const { key } = await createTestProject(getTestDb());
    const app = await buildApp(getTestDb());
    const response = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { origin: "https://customer.example", "x-tripcord-key": key },
      payload: {
        sessionId: "s",
        reason: { type: "manual" },
        events: [],
        meta: { url: "https://customer.example", userAgent: "ua", capturedAt: 1 },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["access-control-allow-origin"]).toBe("https://customer.example");
  });
});

describe("CSRF guard", () => {
  it("rejects a mutating /api request without a matching Origin", async () => {
    const app = await buildApp(getTestDb(), { logLevel: "silent" });

    const missing = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: "Cross-origin request blocked" });

    const foreign = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: "https://evil.example" } });
    expect(foreign.statusCode).toBe(403);
  });

  it("rejects a non-JSON body even from the right Origin", async () => {
    const app = await buildApp(getTestDb(), { logLevel: "silent" });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { origin: TEST_ORIGIN, "content-type": "text/plain" },
      payload: "x",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Content-Type must be application/json" });
  });

  it("lets a same-origin request through", async () => {
    await resetDb(getTestDb());
    const user = await createTestUser(getTestDb());
    const app = await buildApp(getTestDb(), { logLevel: "silent" });
    const response = await call(app, "POST", "/api/auth/logout", { cookie: await sessionCookie(getTestDb(), user.id) });
    expect(response.statusCode).toBe(204);
  });
});
