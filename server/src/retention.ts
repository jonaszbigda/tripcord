import { lt } from "drizzle-orm";
import type { Database } from "./db/client";
import { timelines } from "./db/schema";
import { deleteStalePasswordResets } from "./db/password-resets";
import { deleteExpiredSessions } from "./db/sessions";
import { deleteStaleEmailVerifications } from "./db/email-verifications";
import { deleteUnverifiedAccounts } from "./email-verification";

export async function cleanupOldTimelines(db: Database, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(timelines).where(lt(timelines.receivedAt, cutoff)).returning({ id: timelines.id });
  return deleted.length;
}

export async function runCleanup(db: Database, retentionDays: number, emailVerification: boolean): Promise<void> {
  // One failing step doesn't stop the others; the failures are thrown together at the end.
  const results = await Promise.allSettled([
    cleanupOldTimelines(db, retentionDays),
    deleteExpiredSessions(db),
    deleteStalePasswordResets(db),
    deleteStaleEmailVerifications(db),
  ]);
  const errors: unknown[] = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  // Only while verification is on: after a switch back to invite-only, the
  // unverified users can use the app and must not be deleted.
  if (emailVerification) {
    try {
      const { skipped } = await deleteUnverifiedAccounts(db);
      for (const userId of skipped) {
        console.warn(`[tripcord-server] kept unverified user ${userId}: only owner of an org with other members`);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} cleanup step(s) failed`);
  }
}

export function scheduleCleanup(
  db: Database,
  retentionDays: number,
  emailVerification: boolean,
  intervalMs: number = 24 * 60 * 60 * 1000
): ReturnType<typeof setInterval> {
  const run = () => {
    runCleanup(db, retentionDays, emailVerification).catch((error: unknown) => {
      console.error("[tripcord-server] cleanup job failed:", error);
    });
  };

  // Run once immediately at boot, not just on the interval — otherwise any
  // deployment that restarts more often than `intervalMs` (default 24h)
  // never enforces retention at all.
  run();
  return setInterval(run, intervalMs);
}
