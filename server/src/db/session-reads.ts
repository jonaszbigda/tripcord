import { and, arrayOverlaps, asc, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { TimelineEvent } from "@tripcord/js";
import type { Database } from "./client";
import { captures, timelineSessions } from "./schema";

export const RANGES = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" } as const;
export type Range = keyof typeof RANGES;

export const REASON_TYPES = ["error", "unhandledrejection", "manual"] as const;
export type ReasonType = (typeof REASON_TYPES)[number];

export interface TimelineFilters {
  range: Range;
  /** Empty means every type. */
  reasonTypes: ReasonType[];
  /** Matched as any-of. Empty means no tag filter. */
  tags: string[];
  /** A top-reasons key (see REASON_KEY). */
  reason?: string;
}

export interface SessionListRow {
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  reasonTypes: string[];
  url: string | null;
  tags: string[];
  eventCount: number;
  captureCount: number;
}

export interface SessionPage {
  sessions: SessionListRow[];
  nextCursor: string | null;
}

export interface SessionCaptureRow {
  id: string;
  receivedAt: string;
  occurredAt: string;
  reasonType: string;
  reason: unknown;
  meta: unknown;
  tags: string[];
}

export interface SessionDetail {
  session: {
    sessionId: string;
    firstSeenAt: string;
    lastSeenAt: string;
    url: string | null;
    tags: string[];
    events: TimelineEvent[];
  };
  captures: SessionCaptureRow[];
}

export interface VolumeBucket {
  start: string;
  error: number;
  unhandledrejection: number;
  manual: number;
}

export interface TopReason {
  key: string;
  type: string;
  name: string | null;
  message: string | null;
  count: number;
  lastSeen: string;
}

export interface TimelineSummary {
  projectHasTimelines: boolean;
  bucket: "hour" | "day";
  buckets: VolumeBucket[];
  topReasons: TopReason[];
}

export type TagCount = { tag: string; count: number };

export interface ExportedCapture {
  id: string;
  receivedAt: string;
  sessionId: string;
  reasonType: string;
  reason: unknown;
  events: unknown;
  meta: unknown;
  tags: string[];
}

export interface SessionCursor {
  lastSeenAt: string;
  sessionId: string;
}

// received_at holds UTC wall-clock time. This renders it as ISO-8601 with all six
// fractional digits; a JS Date would drop the last three.
function isoTimestamp(value: AnyColumn | SQL): SQL<string> {
  return sql<string>`to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const REASON_NAME = sql<string | null>`${captures.reason}->>'name'`;
const REASON_MESSAGE = sql<string | null>`${captures.reason}->>'message'`;
const MESSAGE_PREVIEW = sql<string | null>`left(${REASON_MESSAGE}, 300)`;
const REASON_KEY = sql<string>`md5(jsonb_build_array(${captures.reasonType}, ${REASON_NAME}, ${REASON_MESSAGE})::text)`;

// A session's captures, in range, matched against every filter. One place, so
// the list and the summary can't disagree about what a filter means.
function filterConditions(projectId: string, filters: TimelineFilters): SQL[] {
  const conditions: SQL[] = [
    eq(captures.projectId, projectId),
    sql`${captures.receivedAt} >= (now() AT TIME ZONE 'UTC') - ${RANGES[filters.range]}::interval`,
  ];
  if (filters.reasonTypes.length > 0) {
    conditions.push(inArray(captures.reasonType, filters.reasonTypes));
  }
  if (filters.tags.length > 0) {
    conditions.push(arrayOverlaps(captures.tags, filters.tags));
  }
  if (filters.reason !== undefined) {
    conditions.push(sql`${REASON_KEY} = ${filters.reason}`);
  }
  return conditions;
}

function whereAll(conditions: SQL[]): SQL {
  return sql.join(
    conditions.map((condition) => sql`(${condition})`),
    sql` AND `
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function encodeCursor(cursor: SessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** The cursor, or undefined if the value isn't one this server made. */
export function decodeCursor(value: string): SessionCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const { lastSeenAt, sessionId } = parsed as Record<string, unknown>;
    return typeof lastSeenAt === "string" &&
      CURSOR_TIMESTAMP.test(lastSeenAt) &&
      typeof sessionId === "string" &&
      sessionId.length > 0
      ? { lastSeenAt, sessionId }
      : undefined;
  } catch {
    return undefined;
  }
}

// One row per session that has at least one capture in range. Newest activity
// first, keyset-paged on (last seen, session id).
export async function listSessions(
  db: Database,
  projectId: string,
  filters: TimelineFilters,
  page: { cursor?: SessionCursor; limit: number }
): Promise<SessionPage> {
  const having = page.cursor
    ? sql`HAVING (max(${captures.receivedAt}), ${captures.sessionId}) < (${page.cursor.lastSeenAt}::timestamp, ${page.cursor.sessionId})`
    : sql``;
  const result = await db.execute<{
    sessionId: string;
    firstSeenAt: string;
    lastSeenAt: string;
    reasonTypes: string[];
    tags: string[];
    url: string | null;
    eventCount: number;
    captureCount: number;
  }>(sql`
    SELECT
      ${captures.sessionId} AS "sessionId",
      ${isoTimestamp(sql`min(${captures.receivedAt})`)} AS "firstSeenAt",
      ${isoTimestamp(sql`max(${captures.receivedAt})`)} AS "lastSeenAt",
      ${sql`array_agg(DISTINCT ${captures.reasonType})`} AS "reasonTypes",
      ${sql`coalesce(array_agg(DISTINCT t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}'::text[])`} AS "tags",
      ${sql`(array_agg(${captures.meta}->>'url' ORDER BY ${captures.receivedAt} DESC))[1]`} AS "url",
      ${sql`coalesce(jsonb_array_length(${timelineSessions.events}), 0)::int`} AS "eventCount",
      ${sql`count(DISTINCT ${captures.id})::int`} AS "captureCount"
    FROM ${captures}
    LEFT JOIN ${timelineSessions}
      ON ${timelineSessions.projectId} = ${captures.projectId}
     AND ${timelineSessions.sessionId} = ${captures.sessionId}
    LEFT JOIN LATERAL unnest(${captures.tags}) AS t(tag) ON TRUE
    WHERE ${whereAll(filterConditions(projectId, filters))}
    GROUP BY ${captures.sessionId}, ${timelineSessions.id}
    ${having}
    ORDER BY max(${captures.receivedAt}) DESC, ${captures.sessionId} DESC
    LIMIT ${page.limit + 1}
  `);

  const hasMore = result.rows.length > page.limit;
  const rows = hasMore ? result.rows.slice(0, page.limit) : result.rows;
  const sessions: SessionListRow[] = rows.map((row) => ({
    sessionId: row.sessionId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    reasonTypes: row.reasonTypes,
    url: row.url,
    tags: dedupe(row.tags),
    eventCount: row.eventCount,
    captureCount: row.captureCount,
  }));
  const last = sessions[sessions.length - 1];
  return {
    sessions,
    nextCursor: hasMore && last ? encodeCursor({ lastSeenAt: last.lastSeenAt, sessionId: last.sessionId }) : null,
  };
}

export async function getSession(db: Database, projectId: string, sessionId: string): Promise<SessionDetail | undefined> {
  // Metadata comes from an aggregate over every capture, so it's correct even
  // past the (bounded) list below.
  const meta = await db.execute<{
    firstSeenAt: string;
    lastSeenAt: string;
    tags: string[];
    url: string | null;
    captureCount: number;
  }>(sql`
    SELECT
      ${isoTimestamp(sql`min(${captures.receivedAt})`)} AS "firstSeenAt",
      ${isoTimestamp(sql`max(${captures.receivedAt})`)} AS "lastSeenAt",
      ${sql`coalesce(array_agg(DISTINCT t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}'::text[])`} AS "tags",
      ${sql`(array_agg(${captures.meta}->>'url' ORDER BY ${captures.receivedAt} DESC))[1]`} AS "url",
      ${sql`count(*)::int`} AS "captureCount"
    FROM ${captures}
    LEFT JOIN LATERAL unnest(${captures.tags}) AS t(tag) ON TRUE
    WHERE ${and(eq(captures.projectId, projectId), eq(captures.sessionId, sessionId))}
  `);
  const summary = meta.rows[0];
  if (!summary || summary.captureCount === 0) {
    return undefined;
  }

  const captureRows = await db
    .select({
      id: captures.id,
      receivedAt: isoTimestamp(captures.receivedAt),
      occurredAt: isoTimestamp(captures.occurredAt),
      reasonType: captures.reasonType,
      reason: captures.reason,
      meta: captures.meta,
      tags: captures.tags,
    })
    .from(captures)
    .where(and(eq(captures.projectId, projectId), eq(captures.sessionId, sessionId)))
    .orderBy(asc(captures.receivedAt), asc(captures.id))
    .limit(100);

  const [session] = await db
    .select({ events: timelineSessions.events })
    .from(timelineSessions)
    .where(and(eq(timelineSessions.projectId, projectId), eq(timelineSessions.sessionId, sessionId)));

  return {
    session: {
      sessionId,
      firstSeenAt: summary.firstSeenAt,
      lastSeenAt: summary.lastSeenAt,
      url: summary.url,
      tags: dedupe(summary.tags),
      events: (session?.events as TimelineEvent[] | undefined) ?? [],
    },
    captures: captureRows,
  };
}

export async function summarizeTimelines(
  db: Database,
  projectId: string,
  filters: TimelineFilters,
  timeZone: string
): Promise<TimelineSummary> {
  const unit = filters.range === "24h" ? "hour" : "day";
  const where = whereAll(filterConditions(projectId, filters));
  const [projectHasTimelines, buckets, topReasons] = await Promise.all([
    hasAnyCapture(db, projectId),
    volume(db, where, filters.range, unit, timeZone),
    topReasonsWhere(db, where),
  ]);
  return { projectHasTimelines, bucket: unit, buckets, topReasons };
}

async function hasAnyCapture(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db.select({ id: captures.id }).from(captures).where(eq(captures.projectId, projectId)).limit(1);
  return row !== undefined;
}

async function volume(
  db: Database,
  where: SQL,
  range: Range,
  unit: "hour" | "day",
  timeZone: string
): Promise<VolumeBucket[]> {
  const result = await db.execute<{ start_ms: number; error: number; unhandledrejection: number; manual: number }>(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc(${unit}::text, (now() AT TIME ZONE ${timeZone}::text) - ${RANGES[range]}::interval),
        date_trunc(${unit}::text, now() AT TIME ZONE ${timeZone}::text),
        ${`1 ${unit}`}::interval
      ) AS bucket
    ),
    counts AS (
      SELECT date_trunc(${unit}::text, (${captures.receivedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text) AS bucket,
             ${captures.reasonType} AS reason_type,
             count(*)::int AS n
      FROM ${captures}
      WHERE ${where}
      GROUP BY 1, 2
    )
    SELECT (extract(epoch FROM series.bucket AT TIME ZONE ${timeZone}::text) * 1000)::float8 AS start_ms,
           coalesce(sum(counts.n) FILTER (WHERE counts.reason_type = 'error'), 0)::int AS error,
           coalesce(sum(counts.n) FILTER (WHERE counts.reason_type = 'unhandledrejection'), 0)::int AS unhandledrejection,
           coalesce(sum(counts.n) FILTER (WHERE counts.reason_type = 'manual'), 0)::int AS manual
    FROM series
    LEFT JOIN counts ON counts.bucket = series.bucket
    GROUP BY series.bucket
    ORDER BY series.bucket
  `);
  return result.rows.map((row) => ({
    start: new Date(row.start_ms).toISOString(),
    error: row.error,
    unhandledrejection: row.unhandledrejection,
    manual: row.manual,
  }));
}

async function topReasonsWhere(db: Database, where: SQL): Promise<TopReason[]> {
  const count = sql<number>`count(*)::int`;
  const lastSeen = sql`max(${captures.receivedAt})`;
  return db
    .select({
      key: REASON_KEY,
      type: captures.reasonType,
      name: REASON_NAME,
      message: MESSAGE_PREVIEW,
      count,
      lastSeen: isoTimestamp(lastSeen),
    })
    .from(captures)
    .where(where)
    .groupBy(captures.reasonType, REASON_NAME, REASON_MESSAGE)
    .orderBy(sql`count(*) DESC`, sql`max(${captures.receivedAt}) DESC`)
    .limit(10);
}

/** Distinct tags in the range with counts. Ignores every filter but the range. */
export async function listTags(db: Database, projectId: string, range: Range): Promise<TagCount[]> {
  const where = whereAll(filterConditions(projectId, { range, reasonTypes: [], tags: [] }));
  const result = await db.execute<TagCount>(sql`
    SELECT tag, count(*)::int AS count
    FROM ${captures}, unnest(${captures.tags}) AS tag
    WHERE ${where}
    GROUP BY tag
    ORDER BY count DESC, tag
    LIMIT 100
  `);
  return result.rows;
}

/**
 * Every capture of a project, oldest first, `batchSize` rows per query, each
 * carrying its session's baked events. Keyset-paged on (received_at, id) with
 * microsecond timestamps, so rows sharing a timestamp are neither lost nor
 * repeated.
 */
export async function* exportCaptures(
  db: Database,
  projectId: string,
  batchSize = 500
): AsyncGenerator<ExportedCapture> {
  let after: { receivedAt: string; id: string } | undefined;
  for (;;) {
    const conditions: SQL[] = [eq(captures.projectId, projectId)];
    if (after) {
      conditions.push(
        sql`(${captures.receivedAt}, ${captures.id}) > (${after.receivedAt}::timestamp, ${after.id}::uuid)`
      );
    }
    const rows = await db
      .select({
        id: captures.id,
        receivedAt: isoTimestamp(captures.receivedAt),
        sessionId: captures.sessionId,
        reasonType: captures.reasonType,
        reason: captures.reason,
        events: timelineSessions.events,
        meta: captures.meta,
        tags: captures.tags,
      })
      .from(captures)
      .leftJoin(
        timelineSessions,
        and(eq(timelineSessions.projectId, captures.projectId), eq(timelineSessions.sessionId, captures.sessionId))
      )
      .where(whereAll(conditions))
      .orderBy(asc(captures.receivedAt), asc(captures.id))
      .limit(batchSize);
    for (const row of rows) {
      yield { ...row, events: row.events ?? [] };
    }
    if (rows.length < batchSize) {
      return;
    }
    const last = rows[rows.length - 1];
    after = { receivedAt: last.receivedAt, id: last.id };
  }
}
