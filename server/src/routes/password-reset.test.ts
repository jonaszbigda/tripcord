import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { TEST_ORIGIN, buildTestApp, call } from "../../test/http";
import { FakeMailer } from "../../test/mailer";

describe("password reset routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("don't exist without a mailer", async () => {
    const app = await buildTestApp(getTestDb());
    const response = await call(app, "POST", "/api/auth/password-reset", { body: { email: "a@example.com" } });
    expect(response.statusCode).toBe(404);
  });

  it("answer 204 for known and unknown addresses alike", async () => {
    await createTestUser(getTestDb(), { email: "ana@example.com" });
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { mailer });

    const known = await call(app, "POST", "/api/auth/password-reset", { body: { email: "ana@example.com" } });
    const unknown = await call(app, "POST", "/api/auth/password-reset", { body: { email: "nobody@example.com" } });

    expect([known.statusCode, unknown.statusCode]).toEqual([204, 204]);
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
    expect(mailer.sent[0].text).toContain(`${TEST_ORIGIN}/reset-password/tpr_`);
  });

  it("reset the password from the emailed link and log the user out everywhere", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", password: "old-password" });
    const oldCookie = await sessionCookie(getTestDb(), user.id);
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { mailer });

    await call(app, "POST", "/api/auth/password-reset", { body: { email: "ana@example.com" } });
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
    const token = mailer.sent[0].text.match(/(tpr_[A-Za-z0-9_-]+)/)![1];

    const confirm = await call(app, "POST", "/api/auth/password-reset/confirm", {
      body: { token, newPassword: "new-password" },
    });
    expect(confirm.statusCode).toBe(204);

    expect((await call(app, "GET", "/api/me", { cookie: oldCookie })).statusCode).toBe(401);
    const login = await call(app, "POST", "/api/auth/login", { body: { email: "ana@example.com", password: "new-password" } });
    expect(login.statusCode).toBe(200);

    const again = await call(app, "POST", "/api/auth/password-reset/confirm", { body: { token, newPassword: "another-one" } });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: "This reset link is invalid or has expired" });
  });

  it("validates the new password like a password change", async () => {
    const app = await buildTestApp(getTestDb(), { mailer: new FakeMailer() });
    const response = await call(app, "POST", "/api/auth/password-reset/confirm", { body: { token: "tpr_x", newPassword: "short" } });
    expect(response.statusCode).toBe(400);
  });

  it("logs the send failure and still answers 204", async () => {
    await createTestUser(getTestDb(), { email: "ana@example.com" });
    const failing = { send: vi.fn().mockRejectedValue(new Error("SMTP down")) };
    const app = await buildTestApp(getTestDb(), { mailer: failing });

    const response = await call(app, "POST", "/api/auth/password-reset", { body: { email: "ana@example.com" } });

    expect(response.statusCode).toBe(204);
    await vi.waitFor(() => expect(failing.send).toHaveBeenCalledOnce());
  });
});
