import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { FakeMailer } from "../../test/mailer";
import { findUserByEmail } from "../db/users";

const ACTIVE = { signup: "open" as const };

async function unverifiedSession() {
  const user = await createTestUser(getTestDb(), { email: "ana@example.com", password: "long-password", emailVerified: false });
  return { user, cookie: await sessionCookie(getTestDb(), user.id) };
}

describe("email verification gate", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("answers 403 on gated routes and lets the allowlist through", async () => {
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const { cookie } = await unverifiedSession();

    const orgs = await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } });
    expect(orgs.statusCode).toBe(403);
    expect(orgs.json()).toEqual({ error: "Email not verified" });

    const me = await call(app, "GET", "/api/me", { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.emailVerified).toBe(false);
  });

  it("is off with invite-only signup, and me says verified (review focus 4)", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "invite-only", mailer: new FakeMailer() });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } })).statusCode).toBe(201);
    expect((await call(app, "GET", "/api/me", { cookie })).json().user.emailVerified).toBe(true);
  });

  it("is off with open signup but no SMTP", async () => {
    const app = await buildTestApp(getTestDb(), ACTIVE);
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } })).statusCode).toBe(201);
  });

  it("reports whether verification is on in /api/auth/config", async () => {
    const on = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const off = await buildTestApp(getTestDb(), ACTIVE);
    expect((await call(on, "GET", "/api/auth/config")).json().emailVerification).toBe(true);
    expect((await call(off, "GET", "/api/auth/config")).json().emailVerification).toBe(false);
  });
});

describe("password signup with verification", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates an unverified account and emails a link", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });

    const response = await call(app, "POST", "/api/auth/signup", {
      body: { email: "ana@example.com", name: "Ana", password: "long-password" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user.emailVerified).toBe(false);
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
    expect(mailer.sent[0].text).toContain("/verify-email/tpv_");
  });

  it("still creates the account when SMTP fails (review focus 5)", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("SMTP down")) };
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: failing });

    const response = await call(app, "POST", "/api/auth/signup", {
      body: { email: "ana@example.com", name: "Ana", password: "long-password" },
    });

    expect(response.statusCode).toBe(201);
    await vi.waitFor(() => expect(failing.send).toHaveBeenCalledOnce());
    expect(await findUserByEmail(getTestDb(), "ana@example.com")).toBeDefined();
  });

  it("creates a verified account when verification is off", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });

    await call(app, "POST", "/api/auth/signup", { body: { email: "ana@example.com", name: "Ana", password: "long-password" } });

    expect((await findUserByEmail(getTestDb(), "ana@example.com"))?.emailVerifiedAt).not.toBeNull();
  });
});
