import { lt } from "drizzle-orm";
import type { Database } from "./db/client";
import { captures } from "./db/schema";
import { pruneTimelineSessions } from "./db/timeline-sessions";
import { deleteStalePasswordResets } from "./db/password-resets";
import { deleteExpiredSessions } from "./db/sessions";
import { deleteStaleEmailVerifications } from "./db/email-verifications";
import { deleteUnverifiedAccounts } from "./email-verification";

export async function cleanupOldCaptures(db: Database, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(captures).where(lt(captures.receivedAt, cutoff)).returning({ id: captures.id });
  return deleted.length;
}

export async function runCleanup(
  db: Database,
  retentionDays: number,
  emailVerification: boolean,
  stagingTtlMs: number
): Promise<void> {
  // One failing step doesn't stop the others; the failures are thrown together at the end.
  const results = await Promise.allSettled([
    cleanupOldCaptures(db, retentionDays),
    // Sessions older than the staging window go, along with any events still
    // staged in them. Their captures were already separated out, so they stay.
    pruneTimelineSessions(db, stagingTtlMs),
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
  stagingTtlMs: number,
  intervalMs: number = 24 * 60 * 60 * 1000
): ReturnType<typeof setInterval> {
  const run = () => {
    runCleanup(db, retentionDays, emailVerification, stagingTtlMs).catch((error: unknown) => {
      console.error("[tripcord-server] cleanup job failed:", error);
    });
  };

  // Run once immediately at boot, not just on the interval — otherwise any
  // deployment that restarts more often than `intervalMs` (default 24h)
  // never enforces retention at all.
  run();
  return setInterval(run, intervalMs);
}
