import { and, count, eq, isNull, lt } from "drizzle-orm";
import type { Executor } from "./client";
import { users, type User } from "./schema";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface NewUser {
  email: string;
  name: string;
  passwordHash: string | null;
  githubId: string | null;
  /** NULL (the default) until the owner proves the address. */
  emailVerifiedAt?: Date | null;
}

export async function insertUser(ex: Executor, input: NewUser): Promise<User> {
  const [user] = await ex
    .insert(users)
    .values({ ...input, email: normalizeEmail(input.email) })
    .returning();
  return user;
}

export async function findUserById(ex: Executor, id: string): Promise<User | undefined> {
  const [user] = await ex.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

export async function findUserByEmail(ex: Executor, email: string): Promise<User | undefined> {
  const [user] = await ex.select().from(users).where(eq(users.email, normalizeEmail(email))).limit(1);
  return user;
}

export async function findUserByGithubId(ex: Executor, githubId: string): Promise<User | undefined> {
  const [user] = await ex.select().from(users).where(eq(users.githubId, githubId)).limit(1);
  return user;
}

export async function countUsers(ex: Executor): Promise<number> {
  const [row] = await ex.select({ n: count() }).from(users);
  return row.n;
}

export async function setPasswordHash(ex: Executor, userId: string, passwordHash: string): Promise<void> {
  await ex.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function setGithubId(ex: Executor, userId: string, githubId: string | null): Promise<void> {
  await ex.update(users).set({ githubId }).where(eq(users.id, userId));
}

export async function setEmail(ex: Executor, userId: string, email: string): Promise<void> {
  await ex.update(users).set({ email: normalizeEmail(email) }).where(eq(users.id, userId));
}

/** Records the first verification; later calls keep the original time. */
export async function markEmailVerified(ex: Executor, userId: string, now = new Date()): Promise<void> {
  await ex
    .update(users)
    .set({ emailVerifiedAt: now })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
}

export async function listUnverifiedUserIds(ex: Executor, createdBefore: Date): Promise<string[]> {
  const rows = await ex
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.emailVerifiedAt), lt(users.createdAt, createdBefore)));
  return rows.map((row) => row.id);
}
