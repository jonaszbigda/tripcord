import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTestDb } from "../test/db";
import { buildTestApp, call } from "../test/http";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tripcord-dashboard-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>tripcord-spa</title>");
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets", "app.js"), "console.log('app')");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("dashboard serving", () => {
  it("serves index.html at / and for client-side routes", async () => {
    const app = await buildTestApp(getTestDb(), { dashboardDir: dir });

    for (const url of ["/", "/orgs/123/projects", "/invite/rpi_abc?x=1", "/login"]) {
      const response = await call(app, "GET", url);
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
      expect(response.headers["content-type"]).toMatch(/^text\/html/);
      expect(response.body).toContain("tripcord-spa");
    }
  });

  it("serves built assets", async () => {
    const app = await buildTestApp(getTestDb(), { dashboardDir: dir });
    const response = await call(app, "GET", "/assets/app.js");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("console.log");
  });

  it("keeps JSON 404s for API paths and non-GET requests", async () => {
    const app = await buildTestApp(getTestDb(), { dashboardDir: dir });

    for (const url of ["/api/nope", "/v1/nope", "/api"]) {
      const response = await call(app, "GET", url);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not Found" });
    }
    expect((await call(app, "POST", "/somewhere")).statusCode).toBe(404);
    expect((await call(app, "GET", "/health")).json()).toEqual({ status: "ok" });
  });

  it("serves nothing when the directory is unset or has no index.html", async () => {
    for (const dashboardDir of [undefined, path.join(dir, "missing")]) {
      const app = await buildTestApp(getTestDb(), { dashboardDir });
      const response = await call(app, "GET", "/");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Not Found" });
    }
  });
});
