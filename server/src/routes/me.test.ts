import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { hashToken } from "../auth/tokens";
import { addMember, createOrgWithOwner } from "../db/orgs";
import { sessions } from "../db/schema";
import { createSession, findSessionUser } from "../db/sessions";
import { findUserById } from "../db/users";
import { verifyPassword } from "../auth/password";

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
    const response = await call(app, "GET", "/api/me", { cookie: "tripcord_session=bogus" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await db.insert(sessions).values({ tokenHash: hashToken("old"), userId: user.id, expiresAt: new Date(Date.now() - 1) });
    const app = await buildTestApp(db);

    const response = await call(app, "GET", "/api/me", { cookie: "tripcord_session=old" });

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
      user: { id: user.id, email: "ana@example.com", name: "Ana", hasPassword: true, githubConnected: false, emailVerified: true },
      orgs: [{ id: org.id, name: "Acme", role: "owner" }],
    });
    expect(response.body).not.toContain("scrypt");
  });
});

describe("POST /api/me/password", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("changes the password and logs out every other session", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { password: "old-password" });
    const current = await createSession(db, user.id);
    const other = await createSession(db, user.id);
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/me/password", {
      cookie: `tripcord_session=${current.token}`,
      body: { currentPassword: "old-password", newPassword: "new-password" },
    });

    expect(response.statusCode).toBe(204);
    const updated = await findUserById(db, user.id);
    expect(await verifyPassword("new-password", updated!.passwordHash!)).toBe(true);
    expect(await findSessionUser(db, current.token)).toBeDefined();
    expect(await findSessionUser(db, other.token)).toBeUndefined();
  });

  it("requires the correct current password", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { password: "old-password" });
    const app = await buildTestApp(db);
    const cookie = await sessionCookie(db, user.id);

    for (const body of [{ currentPassword: "wrong-password", newPassword: "new-password" }, { newPassword: "new-password" }]) {
      const response = await call(app, "POST", "/api/me/password", { cookie, body });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Current password is incorrect" });
    }
  });

  it("lets a GitHub-only user set a first password", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "9" });
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/me/password", {
      cookie: await sessionCookie(db, user.id),
      body: { newPassword: "first-password" },
    });

    expect(response.statusCode).toBe(204);
    expect((await findUserById(db, user.id))?.passwordHash).toMatch(/^scrypt\$/);
  });
});

describe("DELETE /api/me/github", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("disconnects GitHub when the user has a password", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "9", password: "a-password" });
    const app = await buildTestApp(db);

    const response = await call(app, "DELETE", "/api/me/github", { cookie: await sessionCookie(db, user.id) });

    expect(response.statusCode).toBe(204);
    expect((await findUserById(db, user.id))?.githubId).toBeNull();
  });

  it("refuses when it would leave no way to log in", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "9" });
    const app = await buildTestApp(db);

    const response = await call(app, "DELETE", "/api/me/github", { cookie: await sessionCookie(db, user.id) });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Set a password before disconnecting GitHub" });
  });
});

describe("DELETE /api/me", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes a password user who confirms with their password, and clears the cookie", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { password: "correct horse" });
    const cookie = await sessionCookie(db, user.id);
    const app = await buildTestApp(db);

    const wrong = await call(app, "DELETE", "/api/me", { cookie, body: { password: "wrong horse" } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: "Password is incorrect" });

    const response = await call(app, "DELETE", "/api/me", { cookie, body: { password: "correct horse" } });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers["set-cookie"])).toMatch(/^tripcord_session=;/);
    expect((await call(app, "GET", "/api/me", { cookie })).statusCode).toBe(401);
    expect(await findUserById(db, user.id)).toBeUndefined();
  });

  it("deletes a GitHub-only user with an empty body", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "42" });
    const app = await buildTestApp(db);
    const response = await call(app, "DELETE", "/api/me", { cookie: await sessionCookie(db, user.id), body: {} });
    expect(response.statusCode).toBe(204);
  });

  it("lists the orgs that block deletion", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const other = await createTestUser(db);
    const team = await createOrgWithOwner(db, user.id, "Team");
    await addMember(db, team.id, other.id, "member");
    const app = await buildTestApp(db);

    const response = await call(app, "DELETE", "/api/me", { cookie: await sessionCookie(db, user.id), body: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "You're the only owner of an org with other members",
      orgs: [{ id: team.id, name: "Team" }],
    });
  });
});
