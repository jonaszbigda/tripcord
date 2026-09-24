import type { SignupMode } from "./accounts";
import type { Database, Executor } from "./db/client";
import type { User } from "./db/schema";
import {
  consumeEmailVerification,
  createEmailVerification,
  recentEmailVerifications,
  revokeEmailVerifications,
} from "./db/email-verifications";
import { findUserByEmail, findUserById, listUnverifiedUserIds, markEmailVerified, normalizeEmail, setEmail } from "./db/users";
import { deleteUser } from "./deletion";
import { verifyEmailMail, type Mailer } from "./email";

export const EMAIL_VERIFICATION_COOLDOWN_MS = 2 * 60 * 1000;
export const EMAIL_VERIFICATION_DAILY_LIMIT = 5;
export const UNVERIFIED_ACCOUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Open signup is the only way in that doesn't vouch for the address, and
// without SMTP there's no way to check it.
export function isEmailVerificationActive(signup: SignupMode, hasMailer: boolean): boolean {
  return signup === "open" && hasMailer;
}

export function emailVerificationWarning(signup: SignupMode, hasMailer: boolean): string | undefined {
  if (signup === "open" && !hasMailer) {
    return "SIGNUP=open without SMTP: signup emails are not verified and password reset is unavailable. Set SMTP_URL and EMAIL_FROM to enable both.";
  }
  return undefined;
}

export type SendResult =
  | { status: "sent" }
  | { status: "already_verified" }
  | { status: "throttled"; retryAfterSeconds: number };

export type ChangeEmailResult = SendResult | { status: "email_taken" };

// Two limits: one link per address per cooldown, and a daily cap per user, so
// changing the address can't be used to mail strangers.
async function throttleSeconds(ex: Executor, userId: string, email: string, now: Date): Promise<number> {
  const recent = await recentEmailVerifications(ex, userId, new Date(now.getTime() - DAY_MS));
  const waits = [0];
  const lastToEmail = recent.find((row) => row.email === email);
  if (lastToEmail) {
    waits.push(lastToEmail.createdAt.getTime() + EMAIL_VERIFICATION_COOLDOWN_MS - now.getTime());
  }
  if (recent.length >= EMAIL_VERIFICATION_DAILY_LIMIT) {
    // Newest first: once this one leaves the window, there's room for one more.
    const oldestCounted = recent[EMAIL_VERIFICATION_DAILY_LIMIT - 1];
    waits.push(oldestCounted.createdAt.getTime() + DAY_MS - now.getTime());
  }
  return Math.ceil(Math.max(...waits) / 1000);
}

/** Emails `user` a new link. Throws if the mailer does; the link is created first. */
export async function sendVerification(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  user: User,
  now = new Date()
): Promise<SendResult> {
  if (user.emailVerifiedAt !== null) {
    return { status: "already_verified" };
  }
  const wait = await throttleSeconds(db, user.id, user.email, now);
  if (wait > 0) {
    return { status: "throttled", retryAfterSeconds: wait };
  }
  const token = await createEmailVerification(db, user.id, user.email, now);
  await mailer.send(verifyEmailMail(user.email, user.name, `${publicUrl}/verify-email/${token}`));
  return { status: "sent" };
}

/** Verifies the token's user. False for an unknown, expired or used token, or one sent to an old address. */
export async function verifyEmail(db: Database, token: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const consumed = await consumeEmailVerification(tx, token);
    if (!consumed) {
      return false;
    }
    const user = await findUserById(tx, consumed.userId);
    if (!user || user.email !== consumed.email) {
      return false;
    }
    await markEmailVerified(tx, user.id);
    return true;
  });
}

/** Fixes a typo'd address before verification, then sends a link to it. */
export async function changeUnverifiedEmail(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  user: User,
  email: string,
  now = new Date()
): Promise<ChangeEmailResult> {
  if (user.emailVerifiedAt !== null) {
    return { status: "already_verified" };
  }
  const normalized = normalizeEmail(email);
  if (normalized === user.email) {
    return sendVerification(db, mailer, publicUrl, user, now);
  }
  const owner = await findUserByEmail(db, normalized);
  if (owner) {
    return { status: "email_taken" };
  }
  // Checked before changing anything, so a throttled request leaves the address alone.
  const wait = await throttleSeconds(db, user.id, normalized, now);
  if (wait > 0) {
    return { status: "throttled", retryAfterSeconds: wait };
  }
  await db.transaction(async (tx) => {
    await setEmail(tx, user.id, normalized);
    await revokeEmailVerifications(tx, user.id, now);
  });
  return sendVerification(db, mailer, publicUrl, { ...user, email: normalized }, now);
}

/** Deletes accounts left unverified for 7 days. `skipped` holds the ones deleteUser refused. */
export async function deleteUnverifiedAccounts(db: Database, now = new Date()): Promise<{ deleted: number; skipped: string[] }> {
  const ids = await listUnverifiedUserIds(db, new Date(now.getTime() - UNVERIFIED_ACCOUNT_TTL_MS));
  let deleted = 0;
  const skipped: string[] = [];
  for (const id of ids) {
    const result = await deleteUser(db, id);
    if (result.ok) {
      deleted += 1;
    } else {
      skipped.push(id);
    }
  }
  return { deleted, skipped };
}
