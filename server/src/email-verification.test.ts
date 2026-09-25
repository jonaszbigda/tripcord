import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestUser, getTestDb, resetDb } from "../test/db";
import { FakeMailer } from "../test/mailer";
import { deleteStaleEmailVerifications } from "./db/email-verifications";
import { createPasswordReset } from "./db/password-resets";
import { createOrgWithOwner, addMember } from "./db/orgs";
import { emailVerifications, users } from "./db/schema";
import { findUserById, markEmailVerified } from "./db/users";
import {
  changeUnverifiedEmail,
  deleteUnverifiedAccounts,
  emailVerificationWarning,
  isEmailVerificationActive,
  sendVerification,
  verifyEmail,
} from "./email-verification";
import { resetPassword } from "./password-reset";

const PUBLIC_URL = "https://app.tripcord.dev";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function tokenFrom(mailer: FakeMailer, index = 0): string {
  const match = mailer.sent[index].text.match(/\/verify-email\/(tpv_[A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no verification link in the email");
  return match[1];
}

async function reload(id: string) {
  const user = await findUserById(getTestDb(), id);
  if (!user) throw new Error("user is gone");
  return user;
}

describe("activation", () => {
  it("is active only with open signup and a mailer", () => {
    expect(isEmailVerificationActive("open", true)).toBe(true);
    expect(isEmailVerificationActive("open", false)).toBe(false);
    expect(isEmailVerificationActive("invite-only", true)).toBe(false);
    expect(isEmailVerificationActive("invite-only", false)).toBe(false);
  });

  it("warns only for open signup without a mailer", () => {
    expect(emailVerificationWarning("open", false)).toBe(
      "SIGNUP=open without SMTP: signup emails are not verified and password reset is unavailable. Set SMTP_URL and EMAIL_FROM to enable both."
    );
    expect(emailVerificationWarning("open", true)).toBeUndefined();
    expect(emailVerificationWarning("invite-only", false)).toBeUndefined();
  });
});

describe("sendVerification and verifyEmail", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("emails a 24-hour link that verifies the account once", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", name: "Ana", emailVerified: false });
    const mailer = new FakeMailer();

    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user)).toEqual({ status: "sent" });

    expect(mailer.sent[0].to).toBe("ana@example.com");
    const token = tokenFrom(mailer);
    expect(token).toMatch(/^tpv_[A-Za-z0-9_-]{43}$/);
    const [row] = await getTestDb().select().from(emailVerifications).where(eq(emailVerifications.userId, user.id));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(DAY);
    expect(row.email).toBe("ana@example.com");

    expect(await verifyEmail(getTestDb(), token)).toBe(true);
    expect((await reload(user.id)).emailVerifiedAt).not.toBeNull();
    // Review focus 3: a second click fails but leaves the account verified.
    expect(await verifyEmail(getTestDb(), token)).toBe(false);
    expect((await reload(user.id)).emailVerifiedAt).not.toBeNull();
  });

  it("does nothing for a verified user", async () => {
    const user = await createTestUser(getTestDb());
    const mailer = new FakeMailer();
    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user)).toEqual({ status: "already_verified" });
    expect(mailer.sent).toEqual([]);
  });

  it("rejects unknown and expired tokens", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(Date.now() - DAY - MINUTE));

    expect(await verifyEmail(getTestDb(), tokenFrom(mailer))).toBe(false);
    expect(await verifyEmail(getTestDb(), "tpv_unknown")).toBe(false);
    expect((await reload(user.id)).emailVerifiedAt).toBeNull();
  });

  it("allows one link per address per two minutes, and a new link replaces the old one", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    const start = new Date();

    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, start);
    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + 30_000))).toEqual({
      status: "throttled",
      retryAfterSeconds: 90,
    });
    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + 3 * MINUTE))).toEqual({
      status: "sent",
    });

    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 0))).toBe(false);
    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 1))).toBe(true);
  });

  it("doesn't count a link whose email failed to send", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const failing = { send: () => Promise.reject(new Error("SMTP down")) };
    const now = new Date();

    await expect(sendVerification(getTestDb(), failing, PUBLIC_URL, user, now)).rejects.toThrow("SMTP down");

    expect(await sendVerification(getTestDb(), new FakeMailer(), PUBLIC_URL, user, now)).toEqual({ status: "sent" });
  });

  it("sends at most five links per user per day", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    const start = new Date();
    for (let i = 0; i < 5; i += 1) {
      const result = await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + i * 3 * MINUTE));
      expect(result).toEqual({ status: "sent" });
    }

    const sixth = await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + 15 * MINUTE));

    // The first of the five ages out of the 24-hour window at start + 1 day.
    expect(sixth).toEqual({ status: "throttled", retryAfterSeconds: (DAY - 15 * MINUTE) / 1000 });
    expect(mailer.sent).toHaveLength(5);
  });
});

describe("changeUnverifiedEmail", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("changes the address, sends a new link at once, and kills links to the old one", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@exmaple.com", emailVerified: false });
    const mailer = new FakeMailer();
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user);

    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, " Ana@Example.com ")).toEqual({ status: "sent" });

    expect((await reload(user.id)).email).toBe("ana@example.com");
    expect(mailer.sent[1].to).toBe("ana@example.com");
    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 0))).toBe(false);
    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 1))).toBe(true);
  });

  it("kills reset links sent to the old address, so they can't verify the new one", async () => {
    const user = await createTestUser(getTestDb(), { email: "attacker@example.com", emailVerified: false });
    const resetToken = await createPasswordReset(getTestDb(), user.id, user.email);

    expect(await changeUnverifiedEmail(getTestDb(), new FakeMailer(), PUBLIC_URL, user, "victim@example.com")).toEqual({
      status: "sent",
    });

    expect(await resetPassword(getTestDb(), resetToken, "hash")).toBe(false);
    expect((await reload(user.id)).emailVerifiedAt).toBeNull();
  });

  it("won't move a just-verified account to a new address (stale session user)", async () => {
    // The request loaded the user before a link verified them in parallel.
    const stale = await createTestUser(getTestDb(), { email: "attacker@example.com", emailVerified: false });
    await markEmailVerified(getTestDb(), stale.id);
    const mailer = new FakeMailer();

    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, stale, "victim@example.com")).toEqual({
      status: "already_verified",
    });

    expect((await reload(stale.id)).email).toBe("attacker@example.com");
    expect(mailer.sent).toEqual([]);
  });

  it("refuses an address another account has", async () => {
    await createTestUser(getTestDb(), { email: "taken@example.com" });
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();

    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, "Taken@example.com")).toEqual({ status: "email_taken" });
    expect(mailer.sent).toEqual([]);
  });

  it("treats the user's own address, in any case, as a resend", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", emailVerified: false });
    const mailer = new FakeMailer();

    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, "ANA@example.com")).toEqual({ status: "sent" });
    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, "ana@example.com")).toMatchObject({
      status: "throttled",
    });
  });

  it("refuses a verified user", async () => {
    const user = await createTestUser(getTestDb());
    expect(await changeUnverifiedEmail(getTestDb(), new FakeMailer(), PUBLIC_URL, user, "new@example.com")).toEqual({
      status: "already_verified",
    });
    expect((await reload(user.id)).email).toBe(user.email);
  });

  it("is throttled by the daily limit before changing anything", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    const start = new Date();
    for (let i = 0; i < 5; i += 1) {
      await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, `try${i}@example.com`, new Date(start.getTime() + i * 1000));
    }
    const before = (await reload(user.id)).email;

    const result = await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, await reload(user.id), "last@example.com", new Date(start.getTime() + 10_000));

    expect(result).toMatchObject({ status: "throttled" });
    expect((await reload(user.id)).email).toBe(before);
  });
});

describe("cleanup", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes accounts unverified for 7 days, with their own org, and keeps the rest", async () => {
    const db = getTestDb();
    const stale = await createTestUser(db, { emailVerified: false });
    await createOrgWithOwner(db, stale.id, "Stale's org");
    const fresh = await createTestUser(db, { emailVerified: false });
    const verified = await createTestUser(db);
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(users.id, verified.id));
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(users.id, stale.id));

    expect(await deleteUnverifiedAccounts(db)).toEqual({ deleted: 1, skipped: [] });

    expect(await findUserById(db, stale.id)).toBeUndefined();
    expect(await findUserById(db, fresh.id)).toBeDefined();
    expect(await findUserById(db, verified.id)).toBeDefined();
  });

  it("skips an account deleteUser refuses", async () => {
    const db = getTestDb();
    const stale = await createTestUser(db, { emailVerified: false });
    const org = await createOrgWithOwner(db, stale.id, "Shared");
    await addMember(db, org.id, (await createTestUser(db)).id, "member");
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(users.id, stale.id));

    expect(await deleteUnverifiedAccounts(db)).toEqual({ deleted: 0, skipped: [stale.id] });
  });

  it("drops links that expired more than a day ago", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(Date.now() - 3 * DAY));
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user);

    expect(await deleteStaleEmailVerifications(getTestDb())).toBe(1);
  });
});
