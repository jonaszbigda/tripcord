import { describe, it, expect } from "vitest";
import { getTestDb } from "../test/db";
import { buildApp } from "./app";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = await buildApp(getTestDb());
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("CORS", () => {
  it("responds to an OPTIONS preflight for /v1/timeline with 2xx/204 and allows the X-Repro-Key header", async () => {
    const app = await buildApp(getTestDb());
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/timeline",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-repro-key",
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);

    // HTTP headers are case-insensitive and Fastify normalizes to lowercase,
    // so check case-insensitively rather than assuming the exact casing the
    // browser client sends ("X-Repro-Key").
    const allowHeaders = String(response.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowHeaders).toContain("x-repro-key");
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
