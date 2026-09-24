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

function tokenFrom(mailer: FakeMailer, index = 0): string {
  const match = mailer.sent[index].text.match(/\/verify-email\/(tpv_[A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no verification link in the email");
  return match[1];
}

describe("verification routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("verify-email works without a session and unlocks the account (review focus 2)", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    const { cookie } = await unverifiedSession();
    await call(app, "POST", "/api/me/verify-email/resend", { cookie });
    const token = tokenFrom(mailer);

    const verify = await call(app, "POST", "/api/auth/verify-email", { body: { token } });

    expect(verify.statusCode).toBe(204);
    expect((await call(app, "GET", "/api/me", { cookie })).json().user.emailVerified).toBe(true);
    expect((await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } })).statusCode).toBe(201);
  });

  it("verify-email answers 400 for a bad or used token", async () => {
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const response = await call(app, "POST", "/api/auth/verify-email", { body: { token: "tpv_nope" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid or expired link" });
  });

  it("the routes don't exist when verification is off", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "invite-only", mailer: new FakeMailer() });
    const { cookie } = await unverifiedSession();
    expect((await call(app, "POST", "/api/auth/verify-email", { body: { token: "tpv_x" } })).statusCode).toBe(404);
    expect((await call(app, "POST", "/api/me/verify-email/resend", { cookie })).statusCode).toBe(404);
    expect((await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "b@example.com" } })).statusCode).toBe(404);
  });

  it("resend: 204, then 429 with the wait, and 409 once verified", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/me/verify-email/resend", { cookie })).statusCode).toBe(204);
    const again = await call(app, "POST", "/api/me/verify-email/resend", { cookie });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: "Too many verification emails" });
    expect(again.json().retryAfterSeconds).toBeGreaterThan(100);

    await call(app, "POST", "/api/auth/verify-email", { body: { token: tokenFrom(mailer) } });
    const verified = await call(app, "POST", "/api/me/verify-email/resend", { cookie });
    expect(verified.statusCode).toBe(409);
    expect(verified.json()).toEqual({ error: "Email already verified" });
  });

  it("resend answers 204 and logs when SMTP fails", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("SMTP down")) };
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: failing });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/me/verify-email/resend", { cookie })).statusCode).toBe(204);
    expect(failing.send).toHaveBeenCalledOnce();
  });

  it("change email: validates, refuses taken addresses, and sends a link to the new one", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    await createTestUser(getTestDb(), { email: "taken@example.com" });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "not-an-email" } })).statusCode).toBe(400);
    const taken = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "Taken@example.com" } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "Email already registered" });

    const changed = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "ana@example.org" } });
    expect(changed.statusCode).toBe(204);
    expect(mailer.sent.at(-1)?.to).toBe("ana@example.org");
    expect((await call(app, "GET", "/api/me", { cookie })).json().user.email).toBe("ana@example.org");
  });

  it("change email to the current address in another case resends (review focus 1)", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    const { cookie } = await unverifiedSession();

    const response = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "Ana@Example.com" } });

    expect(response.statusCode).toBe(204);
    expect(mailer.sent).toHaveLength(1);
  });

  it("change email is refused once verified", async () => {
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const user = await createTestUser(getTestDb());
    const cookie = await sessionCookie(getTestDb(), user.id);

    const response = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "new@example.com" } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Email already verified" });
  });
});
