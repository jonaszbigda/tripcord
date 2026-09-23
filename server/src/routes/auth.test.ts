import { describe, it, expect, beforeEach } from "vitest";
import { createTestOrg, createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { addMember } from "../db/orgs";
import { createInvite } from "../db/invites";
import { findUserByEmail } from "../db/users";

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

const signupBody = { email: "ana@example.com", name: "Ana", password: "long-password" };

describe("POST /api/auth/signup", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates the account, starts a session, and returns /api/me's body", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });

    const response = await call(app, "POST", "/api/auth/signup", { body: signupBody });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      user: { email: "ana@example.com", name: "Ana", hasPassword: true, githubConnected: false },
      orgs: [{ name: "Ana's org", role: "owner" }],
    });
    const cookie = response.cookies.find((c) => c.name === "repro_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie?.secure).toBeFalsy();
    const me = await call(app, "GET", "/api/me", { cookie: `repro_session=${cookie!.value}` });
    expect(me.statusCode).toBe(200);
  });

  it("marks the cookie Secure when PUBLIC_URL is https", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open", publicUrl: "https://app.example.com" });

    const response = await call(app, "POST", "/api/auth/signup", {
      body: signupBody,
      headers: { origin: "https://app.example.com" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.cookies.find((c) => c.name === "repro_session")?.secure).toBe(true);
  });

  it("normalizes the email and rejects a second signup in another case", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });

    await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, email: "  Ana@Example.COM " } });
    expect(await findUserByEmail(getTestDb(), "ana@example.com")).toBeDefined();

    const again = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, email: "ana@example.com" } });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "Email already registered" });
  });

  it("allows the first signup on an invite-only instance, then closes", async () => {
    const app = await buildTestApp(getTestDb());

    expect((await call(app, "POST", "/api/auth/signup", { body: signupBody })).statusCode).toBe(201);

    const second = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, email: "b@example.com" } });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toEqual({ error: "Signup is invite-only" });
  });

  it("accepts an invite token on an invite-only instance and joins only that org", async () => {
    const db = getTestDb();
    const org = await createTestOrg(db, "Acme");
    const owner = await createTestUser(db);
    await addMember(db, org.id, owner.id, "owner");
    const { token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: owner.id });
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, inviteToken: token } });

    expect(response.statusCode).toBe(201);
    expect(response.json().orgs).toEqual([{ id: org.id, name: "Acme", role: "member" }]);
  });

  it("returns 404 for an unusable invite token", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });
    const response = await call(app, "POST", "/api/auth/signup", { body: { ...signupBody, inviteToken: "rpi_nope" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Invite not found or expired" });
  });

  it.each([
    [{ ...signupBody, password: "short" }, /password/],
    [{ ...signupBody, email: "not-an-email" }, /^Invalid email$/],
    [{ ...signupBody, name: "   " }, /^Name is required$/],
    [{ ...signupBody, name: "Ana\u0007" }, /^Name must not contain control characters$/],
    [{ ...signupBody, extra: true }, /additional properties/],
  ])("rejects an invalid body %o with 400", async (body, message) => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });
    const response = await call(app, "POST", "/api/auth/signup", { body });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(message);
  });
});

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("logs in with a differently-cased email and starts a session", async () => {
    const db = getTestDb();
    await createTestUser(db, { email: "ana@example.com", password: "long-password" });
    const app = await buildTestApp(db);

    const response = await call(app, "POST", "/api/auth/login", {
      body: { email: " ANA@example.com", password: "long-password" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe("ana@example.com");
    expect(response.cookies.find((c) => c.name === "repro_session")?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("gives the same 401 for a wrong password, an unknown email, and a GitHub-only account", async () => {
    const db = getTestDb();
    await createTestUser(db, { email: "ana@example.com", password: "long-password" });
    await createTestUser(db, { email: "gh@example.com", githubId: "7" });
    const app = await buildTestApp(db);

    for (const body of [
      { email: "ana@example.com", password: "wrong-password" },
      { email: "nobody@example.com", password: "long-password" },
      { email: "gh@example.com", password: "long-password" },
    ]) {
      const response = await call(app, "POST", "/api/auth/login", { body });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Invalid email or password" });
      expect(response.cookies).toHaveLength(0);
    }
  });

  it("rate-limits login attempts per IP", async () => {
    const app = await buildTestApp(getTestDb(), { authRateLimitMax: 2 });
    const body = { email: "nobody@example.com", password: "whatever-pw" };

    await call(app, "POST", "/api/auth/login", { body });
    await call(app, "POST", "/api/auth/login", { body });
    const third = await call(app, "POST", "/api/auth/login", { body });

    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatch(/^Rate limit exceeded/);
  });
});
