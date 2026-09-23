import { and, eq, gt, lte, ne } from "drizzle-orm";
import type { Executor } from "./client";
import { sessions, users, type User } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreatedSession {
  /** Plaintext — goes into the cookie, never stored. */
  token: string;
  expiresAt: Date;
}

export async function createSession(ex: Executor, userId: string): Promise<CreatedSession> {
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await ex.insert(sessions).values({ tokenHash: hash, userId, expiresAt });
  return { token, expiresAt };
}

export async function findSessionUser(ex: Executor, token: string): Promise<User | undefined> {
  const [row] = await ex
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row?.user;
}

export async function deleteSession(ex: Executor, token: string): Promise<void> {
  await ex.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Logs a user out everywhere, or everywhere except the session holding `except`. */
export async function deleteUserSessions(ex: Executor, userId: string, options: { except?: string } = {}): Promise<void> {
  await ex
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        options.except === undefined ? undefined : ne(sessions.tokenHash, hashToken(options.except))
      )
    );
}

export async function deleteExpiredSessions(ex: Executor): Promise<number> {
  const deleted = await ex
    .delete(sessions)
    .where(lte(sessions.expiresAt, new Date()))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}
