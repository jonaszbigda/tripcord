import { lt } from "drizzle-orm";
import type { Database } from "./db/client";
import { timelines } from "./db/schema";

export async function cleanupOldTimelines(db: Database, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(timelines).where(lt(timelines.receivedAt, cutoff)).returning({ id: timelines.id });
  return deleted.length;
}

export function scheduleCleanup(
  db: Database,
  retentionDays: number,
  intervalMs: number = 24 * 60 * 60 * 1000
): ReturnType<typeof setInterval> {
  // Run once immediately at boot, not just on the interval — otherwise any
  // deployment that restarts more often than `intervalMs` (default 24h)
  // never enforces retention at all.
  cleanupOldTimelines(db, retentionDays).catch((error: unknown) => {
    console.error("[repro-server] cleanup job failed:", error);
  });

  return setInterval(() => {
    cleanupOldTimelines(db, retentionDays).catch((error: unknown) => {
      console.error("[repro-server] cleanup job failed:", error);
    });
  }, intervalMs);
}
