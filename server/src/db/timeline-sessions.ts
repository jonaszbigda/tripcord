import { and, eq, lt, sql } from "drizzle-orm";
import type { TimelineEvent, TimelineMeta, TimelineReason } from "@tripcord/js";
import type { Database } from "./client";
import { captures, timelineSessions } from "./schema";
import { mergeEvents } from "./event-hash";

/** The most events one session's timeline keeps; past it the oldest are dropped. */
export const MAX_SESSION_EVENTS = 500;

/**
 * Appends events to a session's staging buffer, creating the session if needed.
 * Nothing becomes visible until a capture bakes it. A missing `source` defaults
 * to `"server"`, since this is the path a backend's events take.
 */
export async function stageEvents(
  db: Database,
  projectId: string,
  sessionId: string,
  events: TimelineEvent[]
): Promise<number> {
  const incoming = events.map((event) => ({ ...event, source: event.source ?? "server" })).slice(-MAX_SESSION_EVENTS);
  // The combined buffer is trimmed to the newest MAX_SESSION_EVENTS in the same
  // statement, so a client that stages without ever capturing can't grow a
  // session's jsonb without bound (the cap isn't only applied at bake).
  const combined = sql`(${timelineSessions.pendingEvents} || ${JSON.stringify(incoming)}::jsonb)`;
  const trimmed = sql`(
    SELECT coalesce(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
    FROM (
      SELECT elem, ord
      FROM jsonb_array_elements(${combined}) WITH ORDINALITY AS t(elem, ord)
      ORDER BY ord DESC
      LIMIT ${MAX_SESSION_EVENTS}
    ) newest
  )`;
  await db
    .insert(timelineSessions)
    .values({ projectId, sessionId, pendingEvents: incoming })
    .onConflictDoUpdate({
      target: [timelineSessions.projectId, timelineSessions.sessionId],
      set: {
        // `||` concatenates the arrays; one statement, so a concurrent stage
        // can't read-modify-write the buffer and lose the other's event.
        pendingEvents: trimmed,
        updatedAt: sql`now()`,
      },
    });
  return incoming.length;
}

/** Creates an empty session if one doesn't exist. For the id-mint endpoint. */
export async function ensureTimelineSession(db: Database, projectId: string, sessionId: string): Promise<void> {
  await db.insert(timelineSessions).values({ projectId, sessionId }).onConflictDoNothing();
}

export interface BakeCaptureInput {
  sessionId: string;
  reason: TimelineReason;
  /** Events the caller is sending with the capture (e.g. the browser's buffer). */
  events: TimelineEvent[];
  meta: TimelineMeta;
  tags: string[];
  occurredAt: Date;
}

export interface BakedCapture {
  id: string;
  eventCount: number;
}

/**
 * Records a capture and bakes the session: drains the staged events, merges them
 * with the session's baked events and the capture's own events, dedupes, sorts,
 * caps, and writes the result. One transaction, so a concurrent capture can't
 * lose a staged event.
 */
export async function bakeCapture(db: Database, projectId: string, input: BakeCaptureInput): Promise<BakedCapture> {
  return db.transaction(async (tx) => {
    await tx
      .insert(timelineSessions)
      .values({ projectId, sessionId: input.sessionId })
      .onConflictDoNothing();

    // Lock and read the current events first: Postgres `UPDATE ... RETURNING`
    // returns the *new* row, so draining in the same statement would hand back
    // the empty buffer, not what was staged. The row lock holds a concurrent
    // stage until the update below, so its event lands for the next bake.
    const [row] = await tx
      .select({ pendingEvents: timelineSessions.pendingEvents, events: timelineSessions.events })
      .from(timelineSessions)
      .where(and(eq(timelineSessions.projectId, projectId), eq(timelineSessions.sessionId, input.sessionId)))
      .for("update");
    // The row can vanish between the INSERT and the lock (concurrent project
    // deletion, or the staging sweep). Treat it as an empty session.
    const current = row ?? { pendingEvents: [] as TimelineEvent[], events: [] as TimelineEvent[] };

    const merged = mergeEvents(
      [current.events as TimelineEvent[], current.pendingEvents as TimelineEvent[], input.events],
      MAX_SESSION_EVENTS
    );
    await tx
      .update(timelineSessions)
      .set({ pendingEvents: sql`'[]'::jsonb`, events: merged, updatedAt: sql`now()` })
      .where(and(eq(timelineSessions.projectId, projectId), eq(timelineSessions.sessionId, input.sessionId)));

    const [capture] = await tx
      .insert(captures)
      .values({
        projectId,
        sessionId: input.sessionId,
        reasonType: input.reason.type,
        reason: input.reason,
        meta: input.meta,
        tags: input.tags,
        occurredAt: input.occurredAt,
      })
      .returning({ id: captures.id });

    return { id: capture.id, eventCount: merged.length };
  });
}

/** Deletes sessions whose last write is older than the staging window. */
export async function pruneTimelineSessions(db: Database, stagingTtlMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - stagingTtlMs);
  const deleted = await db
    .delete(timelineSessions)
    .where(lt(timelineSessions.updatedAt, cutoff))
    .returning({ id: timelineSessions.id });
  return deleted.length;
}
