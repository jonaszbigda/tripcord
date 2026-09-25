import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestUser, getTestDb, resetDb } from "../test/db";
import { FakeMailer } from "../test/mailer";
import { hashPassword, verifyPassword } from "./auth/password";
import { createPasswordReset, deleteStalePasswordResets } from "./db/password-resets";
import { passwordResets } from "./db/schema";
import { createSession, findSessionUser } from "./db/sessions";
import { findUserById, setEmail } from "./db/users";
import { requestPasswordReset, resetPassword } from "./password-reset";

const PUBLIC_URL = "https://app.tripcord.dev";

function tokenFrom(mailer: FakeMailer, index = 0): string {
  const match = mailer.sent[index].text.match(/\/reset-password\/(tpr_[A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no reset link in the email");
  return match[1];
}

describe("requestPasswordReset", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("emails a one-hour reset link to a known address, whatever its case", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", name: "Ana" });
    const mailer = new FakeMailer();

    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, " ANA@example.com ")).toBe("sent");

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("ana@example.com");
    const [row] = await getTestDb().select().from(passwordResets).where(eq(passwordResets.userId, user.id));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(60 * 60 * 1000);
    expect(row.email).toBe("ana@example.com");
    expect(tokenFrom(mailer)).toMatch(/^tpr_[A-Za-z0-9_-]{43}$/);
  });

  it("sends nothing for an unknown address", async () => {
    const mailer = new FakeMailer();
    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "nobody@example.com")).toBe("no_user");
    expect(mailer.sent).toEqual([]);
  });

  it("allows one request per user per two minutes, and a new link replaces the old one", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com" });
    const mailer = new FakeMailer();

    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "ana@example.com")).toBe("sent");
    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "ana@example.com")).toBe("cooldown");
    expect(mailer.sent).toHaveLength(1);

    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
    await getTestDb().update(passwordResets).set({ createdAt: threeMinutesAgo }).where(eq(passwordResets.userId, user.id));
    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "ana@example.com")).toBe("sent");

    expect(await resetPassword(getTestDb(), tokenFrom(mailer, 0), "hash")).toBe(false);
    expect(await resetPassword(getTestDb(), tokenFrom(mailer, 1), "hash")).toBe(true);
  });
});

describe("resetPassword", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("sets the password, ends every session, and works once", async () => {
    const user = await createTestUser(getTestDb(), { password: "old-password" });
    const { token: session } = await createSession(getTestDb(), user.id);
    const token = await createPasswordReset(getTestDb(), user.id, user.email);

    expect(await resetPassword(getTestDb(), token, await hashPassword("new-password"))).toBe(true);

    const updated = await findUserById(getTestDb(), user.id);
    expect(await verifyPassword("new-password", updated!.passwordHash!)).toBe(true);
    expect(await findSessionUser(getTestDb(), session)).toBeUndefined();
    expect(await resetPassword(getTestDb(), token, "hash")).toBe(false);
  });

  it("refuses an expired or unknown token", async () => {
    const user = await createTestUser(getTestDb());
    const token = await createPasswordReset(getTestDb(), user.id, user.email, new Date(Date.now() - 2 * 60 * 60 * 1000));

    expect(await resetPassword(getTestDb(), token, "hash")).toBe(false);
    expect(await resetPassword(getTestDb(), "tpr_nope", "hash")).toBe(false);
  });

  it("refuses a link sent to an address the account no longer has", async () => {
    // A reset requested at the same moment as an address change can be stored
    // after the change cleared pending links. It proves the old inbox, not the new one.
    const user = await createTestUser(getTestDb(), { email: "attacker@example.com", password: "old-password", emailVerified: false });
    const token = await createPasswordReset(getTestDb(), user.id, "attacker@example.com");
    await setEmail(getTestDb(), user.id, "victim@example.com");

    expect(await resetPassword(getTestDb(), token, await hashPassword("new-password"))).toBe(false);

    const updated = await findUserById(getTestDb(), user.id);
    expect(updated?.emailVerifiedAt).toBeNull();
    expect(await verifyPassword("old-password", updated!.passwordHash!)).toBe(true);
  });

  it("verifies the email: the link proves the inbox is theirs", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const token = await createPasswordReset(getTestDb(), user.id, user.email);

    expect(await resetPassword(getTestDb(), token, "hash")).toBe(true);

    expect((await findUserById(getTestDb(), user.id))?.emailVerifiedAt).not.toBeNull();
  });

  it("unlinks GitHub from an unverified user: a link made before the reset is untrusted", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false, githubId: "42" });
    const token = await createPasswordReset(getTestDb(), user.id, user.email);

    expect(await resetPassword(getTestDb(), token, "hash")).toBe(true);

    const updated = await findUserById(getTestDb(), user.id);
    expect(updated?.githubId).toBeNull();
    expect(updated?.emailVerifiedAt).not.toBeNull();
  });

  it("keeps a verified user's GitHub link", async () => {
    const user = await createTestUser(getTestDb(), { githubId: "42" });
    const token = await createPasswordReset(getTestDb(), user.id, user.email);

    expect(await resetPassword(getTestDb(), token, "hash")).toBe(true);

    expect((await findUserById(getTestDb(), user.id))?.githubId).toBe("42");
  });
});

describe("deleteStalePasswordResets", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes tokens that expired more than a day ago and keeps the rest", async () => {
    const user = await createTestUser(getTestDb());
    await createPasswordReset(getTestDb(), user.id, user.email, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const other = await createTestUser(getTestDb());
    await createPasswordReset(getTestDb(), other.id, other.email);

    expect(await deleteStalePasswordResets(getTestDb())).toBe(1);
    const left = await getTestDb().select().from(passwordResets);
    expect(left.map((row) => row.userId)).toEqual([other.id]);
  });
});
