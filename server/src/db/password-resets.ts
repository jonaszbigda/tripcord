import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { Executor } from "./client";
import { passwordResets } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** A new reset token for the user. Their earlier unused tokens stop working. */
export async function createPasswordReset(ex: Executor, userId: string, now = new Date()): Promise<string> {
  const { token, hash } = generateToken("tpr_");
  await ex.delete(passwordResets).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  await ex.insert(passwordResets).values({
    tokenHash: hash,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
  });
  return token;
}

export async function latestPasswordResetAt(ex: Executor, userId: string): Promise<Date | undefined> {
  const [row] = await ex
    .select({ createdAt: passwordResets.createdAt })
    .from(passwordResets)
    .where(eq(passwordResets.userId, userId))
    .orderBy(desc(passwordResets.createdAt))
    .limit(1);
  return row?.createdAt;
}

// Conditional update, like consumeInvite: of two concurrent uses of one token,
// only the first finds used_at NULL.
/** The token's user id, marking it used; undefined for an unknown, expired or used token. */
export async function consumePasswordReset(ex: Executor, token: string): Promise<string | undefined> {
  const [row] = await ex
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(
      and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date()))
    )
    .returning({ userId: passwordResets.userId });
  return row?.userId;
}

export async function deleteStalePasswordResets(ex: Executor): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await ex
    .delete(passwordResets)
    .where(lt(passwordResets.expiresAt, cutoff))
    .returning({ tokenHash: passwordResets.tokenHash });
  return deleted.length;
}
