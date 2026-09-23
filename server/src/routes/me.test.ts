import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { hashToken } from "../auth/tokens";
import { createOrgWithOwner } from "../db/orgs";
import { sessions } from "../db/schema";

describe("GET /api/me", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("returns 401 without a session cookie", async () => {
    const app = await buildTestApp(getTestDb());
    const response = await call(app, "GET", "/api/me");
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Not logged in" });
  });

  it("returns 401 for an unknown token", async () => {
    const app = await buildTestApp(getTestDb());
    const response = await call(app, "GET", "/api/me", { cookie: "repro_session=bogus" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await db.insert(sessions).values({ tokenHash: hashToken("old"), userId: user.id, expiresAt: new Date(Date.now() - 1) });
    const app = await buildTestApp(db);

    const response = await call(app, "GET", "/api/me", { cookie: "repro_session=old" });

    expect(response.statusCode).toBe(401);
  });

  it("returns the user and their orgs, never the password hash", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { name: "Ana", email: "ana@example.com", password: "long-password" });
    const org = await createOrgWithOwner(db, user.id, "Acme");
    const app = await buildTestApp(db);

    const response = await call(app, "GET", "/api/me", { cookie: await sessionCookie(db, user.id) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { id: user.id, email: "ana@example.com", name: "Ana", hasPassword: true, githubConnected: false },
      orgs: [{ id: org.id, name: "Acme", role: "owner" }],
    });
    expect(response.body).not.toContain("scrypt");
  });
});
