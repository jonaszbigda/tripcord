import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";

describe("GET /api/auth/config", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("reports signup mode, bootstrap state and GitHub availability", async () => {
    const app = await buildTestApp(getTestDb());
    expect((await call(app, "GET", "/api/auth/config")).json()).toEqual({
      signup: "invite-only",
      bootstrapped: false,
      github: false,
    });

    await createTestUser(getTestDb());
    const configured = await buildTestApp(getTestDb(), {
      signup: "open",
      github: { clientId: "id", clientSecret: "s", baseUrl: "https://github.com" },
    });
    expect((await call(configured, "GET", "/api/auth/config")).json()).toEqual({
      signup: "open",
      bootstrapped: true,
      github: true,
    });
  });
});

describe("POST /api/auth/logout", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes the session and clears the cookie", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const cookie = await sessionCookie(db, user.id);
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/auth/logout", { cookie });

    expect(response.statusCode).toBe(204);
    const cleared = response.cookies.find((c) => c.name === "repro_session");
    expect(cleared?.value).toBe("");
    expect((await call(app, "GET", "/api/me", { cookie })).statusCode).toBe(401);
  });

  it("succeeds without a session", async () => {
    const app = await buildTestApp(getTestDb());
    expect((await call(app, "POST", "/api/auth/logout")).statusCode).toBe(204);
  });
});
