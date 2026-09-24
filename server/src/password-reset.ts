import type { Database } from "./db/client";
import { consumePasswordReset, createPasswordReset, latestPasswordResetAt } from "./db/password-resets";
import { deleteUserSessions } from "./db/sessions";
import { findUserByEmail, findUserById, markEmailVerified, setGithubId, setPasswordHash } from "./db/users";
import { passwordResetMail, type Mailer } from "./email";

export const PASSWORD_RESET_COOLDOWN_MS = 2 * 60 * 1000;

export type ResetRequestOutcome = "sent" | "no_user" | "cooldown";

// The route runs this after replying, so the outcome never reaches the requester.
export async function requestPasswordReset(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  email: string
): Promise<ResetRequestOutcome> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    return "no_user";
  }
  const last = await latestPasswordResetAt(db, user.id);
  if (last && Date.now() - last.getTime() < PASSWORD_RESET_COOLDOWN_MS) {
    return "cooldown";
  }
  const token = await createPasswordReset(db, user.id);
  await mailer.send(passwordResetMail(user.email, user.name, `${publicUrl}/reset-password/${token}`));
  return "sent";
}

/**
 * Sets the password, verifies the address and ends every session. An unverified
 * user also loses their GitHub link. False for an unknown, expired or used token.
 */
export async function resetPassword(db: Database, token: string, passwordHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const userId = await consumePasswordReset(tx, token);
    if (!userId) {
      return false;
    }
    const user = await findUserById(tx, userId);
    await setPasswordHash(tx, userId, passwordHash);
    // Whoever held the account before the address was proven may have linked
    // their own GitHub; the inbox owner is reclaiming it.
    if (user?.emailVerifiedAt === null) {
      await setGithubId(tx, userId, null);
    }
    // The reset link reached this inbox, which is what verification proves.
    await markEmailVerified(tx, userId);
    await deleteUserSessions(tx, userId);
    return true;
  });
}
