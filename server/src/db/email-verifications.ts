import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { Executor } from "./client";
import { emailVerifications } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** A new link for `email`. The user's earlier links stop working. */
export async function createEmailVerification(ex: Executor, userId: string, email: string, now = new Date()): Promise<string> {
  const { token, hash } = generateToken("tpv_");
  await revokeEmailVerifications(ex, userId, now);
  await ex.insert(emailVerifications).values({
    tokenHash: hash,
    userId,
    email,
    createdAt: now,
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
  });
  return token;
}

/** Removes a link entirely, so it no longer counts toward the limits. */
export async function deleteEmailVerification(ex: Executor, token: string): Promise<void> {
  await ex.delete(emailVerifications).where(eq(emailVerifications.tokenHash, hashToken(token)));
}

/** Makes the user's unused links unusable. The rows stay, for the daily limit. */
export async function revokeEmailVerifications(ex: Executor, userId: string, now = new Date()): Promise<void> {
  await ex
    .update(emailVerifications)
    .set({ usedAt: now })
    .where(and(eq(emailVerifications.userId, userId), isNull(emailVerifications.usedAt)));
}

/** The user's links created after `since`, newest first. */
export async function recentEmailVerifications(
  ex: Executor,
  userId: string,
  since: Date
): Promise<{ email: string; createdAt: Date }[]> {
  return ex
    .select({ email: emailVerifications.email, createdAt: emailVerifications.createdAt })
    .from(emailVerifications)
    .where(and(eq(emailVerifications.userId, userId), gt(emailVerifications.createdAt, since)))
    .orderBy(desc(emailVerifications.createdAt));
}

// Conditional update, like consumePasswordReset: of two concurrent uses of one
// token, only the first finds used_at NULL.
/** The token's user and address, marking it used; undefined for an unknown, expired or used token. */
export async function consumeEmailVerification(
  ex: Executor,
  token: string
): Promise<{ userId: string; email: string } | undefined> {
  const [row] = await ex
    .update(emailVerifications)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerifications.tokenHash, hashToken(token)),
        isNull(emailVerifications.usedAt),
        gt(emailVerifications.expiresAt, new Date())
      )
    )
    .returning({ userId: emailVerifications.userId, email: emailVerifications.email });
  return row;
}

/** Links that expired more than a day ago: past the daily limit's window too. */
export async function deleteStaleEmailVerifications(ex: Executor): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await ex
    .delete(emailVerifications)
    .where(lt(emailVerifications.expiresAt, cutoff))
    .returning({ tokenHash: emailVerifications.tokenHash });
  return deleted.length;
}
