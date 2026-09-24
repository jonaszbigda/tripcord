import { and, arrayOverlaps, asc, desc, eq, inArray, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { isUuid } from "../uuid";
import type { Database } from "./client";
import { timelines } from "./schema";

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

export interface Cursor {
  /** receivedAt exactly as the list returned it, microseconds included. */
  receivedAt: string;
  id: string;
}

export interface TimelineListRow {
  id: string;
  receivedAt: string;
  sessionId: string;
  reasonType: string;
  reasonName: string | null;
  reasonMessage: string | null;
  url: string | null;
  tags: string[];
  eventCount: number;
}

export interface TimelinePage {
  timelines: TimelineListRow[];
  nextCursor: string | null;
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

// A type alias, not an interface, so it satisfies db.execute's row constraint.
export type TagCount = { tag: string; count: number };

// received_at holds UTC wall-clock time. This renders it as ISO-8601 with all six
// fractional digits; a JS Date would drop the last three.
function isoTimestamp(value: AnyColumn | SQL): SQL<string> {
  return sql<string>`to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const REASON_NAME = sql<string | null>`${timelines.reason}->>'name'`;
const REASON_MESSAGE = sql<string | null>`${timelines.reason}->>'message'`;
const MESSAGE_PREVIEW = sql<string | null>`left(${REASON_MESSAGE}, 300)`;
// Built only from expressions that top reasons GROUP BY, with no bound
// parameters, so Postgres accepts it in that query's select list.
const REASON_KEY = sql<string>`md5(jsonb_build_array(${timelines.reasonType}, ${REASON_NAME}, ${REASON_MESSAGE})::text)`;

function whereAll(conditions: SQL[]): SQL {
  return sql.join(
    conditions.map((condition) => sql`(${condition})`),
    sql` AND `
  );
}

// The one place filters become SQL; the list, the summary and the tag list all
// start from it, so they can't disagree about what a filter means.
function filterConditions(projectId: string, filters: TimelineFilters): SQL[] {
  const conditions: SQL[] = [
    eq(timelines.projectId, projectId),
    sql`${timelines.receivedAt} >= (now() AT TIME ZONE 'UTC') - ${RANGES[filters.range]}::interval`,
  ];
  if (filters.reasonTypes.length > 0) {
    conditions.push(inArray(timelines.reasonType, filters.reasonTypes));
  }
  if (filters.tags.length > 0) {
    conditions.push(arrayOverlaps(timelines.tags, filters.tags));
  }
  if (filters.reason !== undefined) {
    conditions.push(sql`${REASON_KEY} = ${filters.reason}`);
  }
  return conditions;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.receivedAt}|${cursor.id}`, "utf8").toString("base64url");
}

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** The cursor, or undefined if the value isn't one this server made. */
export function decodeCursor(value: string): Cursor | undefined {
  const parts = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (parts.length !== 2) {
    return undefined;
  }
  const [receivedAt, id] = parts;
  return CURSOR_TIMESTAMP.test(receivedAt) && isUuid(id) ? { receivedAt, id } : undefined;
}

export async function listTimelines(
  db: Database,
  projectId: string,
  filters: TimelineFilters,
  page: { cursor?: Cursor; limit: number }
): Promise<TimelinePage> {
  const conditions = filterConditions(projectId, filters);
  if (page.cursor) {
    // Postgres ignores the cursor's trailing "Z" when casting to timestamp.
    conditions.push(
      sql`(${timelines.receivedAt}, ${timelines.id}) < (${page.cursor.receivedAt}::timestamp, ${page.cursor.id}::uuid)`
    );
  }

  const rows = await db
    .select({
      id: timelines.id,
      receivedAt: isoTimestamp(timelines.receivedAt),
      sessionId: timelines.sessionId,
      reasonType: timelines.reasonType,
      reasonName: REASON_NAME,
      reasonMessage: MESSAGE_PREVIEW,
      url: sql<string | null>`${timelines.meta}->>'url'`,
      tags: timelines.tags,
      eventCount: sql<number>`jsonb_array_length(${timelines.events})`,
    })
    .from(timelines)
    .where(whereAll(conditions))
    .orderBy(desc(timelines.receivedAt), desc(timelines.id))
    .limit(page.limit + 1);

  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    timelines: pageRows,
    nextCursor: hasMore && last ? encodeCursor({ receivedAt: last.receivedAt, id: last.id }) : null,
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
    hasAnyTimeline(db, projectId),
    volume(db, where, filters.range, unit, timeZone),
    topReasonsWhere(db, where),
  ]);
  return { projectHasTimelines, bucket: unit, buckets, topReasons };
}

async function hasAnyTimeline(db: Database, projectId: string): Promise<boolean> {
  const [row] = await db.select({ id: timelines.id }).from(timelines).where(eq(timelines.projectId, projectId)).limit(1);
  return row !== undefined;
}

// Buckets run from the one holding now − range to the one holding now, cut in
// `timeZone`, with empty ones zero-filled. `start` is returned as a UTC instant.
async function volume(db: Database, where: SQL, range: Range, unit: "hour" | "day", timeZone: string): Promise<VolumeBucket[]> {
  const result = await db.execute<{ start_ms: number; error: number; unhandledrejection: number; manual: number }>(sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc(${unit}::text, (now() AT TIME ZONE ${timeZone}::text) - ${RANGES[range]}::interval),
        date_trunc(${unit}::text, now() AT TIME ZONE ${timeZone}::text),
        ${`1 ${unit}`}::interval
      ) AS bucket
    ),
    counts AS (
      SELECT date_trunc(${unit}::text, (${timelines.receivedAt} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text) AS bucket,
             ${timelines.reasonType} AS reason_type,
             count(*)::int AS n
      FROM ${timelines}
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
  const lastSeen = sql`max(${timelines.receivedAt})`;
  return db
    .select({
      key: REASON_KEY,
      type: timelines.reasonType,
      name: REASON_NAME,
      message: MESSAGE_PREVIEW,
      count,
      lastSeen: isoTimestamp(lastSeen),
    })
    .from(timelines)
    .where(where)
    .groupBy(timelines.reasonType, REASON_NAME, REASON_MESSAGE)
    .orderBy(desc(count), desc(lastSeen))
    .limit(10);
}

/** Distinct tags in the range with counts. Ignores every filter but the range. */
export async function listTags(db: Database, projectId: string, range: Range): Promise<TagCount[]> {
  const where = whereAll(filterConditions(projectId, { range, reasonTypes: [], tags: [] }));
  const result = await db.execute<TagCount>(sql`
    SELECT tag, count(*)::int AS count
    FROM ${timelines}, unnest(${timelines.tags}) AS tag
    WHERE ${where}
    GROUP BY tag
    ORDER BY count DESC, tag
    LIMIT 100
  `);
  return result.rows;
}

export async function getTimeline(db: Database, projectId: string, timelineId: string) {
  const [timeline] = await db
    .select({
      id: timelines.id,
      receivedAt: isoTimestamp(timelines.receivedAt),
      sessionId: timelines.sessionId,
      tags: timelines.tags,
      reason: timelines.reason,
      events: timelines.events,
      meta: timelines.meta,
    })
    .from(timelines)
    .where(and(eq(timelines.projectId, projectId), eq(timelines.id, timelineId)));
  if (!timeline) {
    return undefined;
  }

  const siblings = await db
    .select({
      id: timelines.id,
      receivedAt: isoTimestamp(timelines.receivedAt),
      reasonType: timelines.reasonType,
      reasonName: REASON_NAME,
    })
    .from(timelines)
    .where(
      and(eq(timelines.projectId, projectId), eq(timelines.sessionId, timeline.sessionId), ne(timelines.id, timelineId))
    )
    .orderBy(asc(timelines.receivedAt), asc(timelines.id))
    .limit(20);

  return { timeline, siblings };
}

export interface ExportedTimeline {
  id: string;
  receivedAt: string;
  sessionId: string;
  reasonType: string;
  reason: unknown;
  events: unknown;
  meta: unknown;
  tags: string[];
}

/**
 * Every timeline of a project, oldest first, `batchSize` rows per query.
 * Keyset-paged on (received_at, id) with microsecond timestamps, the same way
 * listTimelines pages, so rows sharing a timestamp are neither lost nor repeated.
 */
export async function* exportTimelines(db: Database, projectId: string, batchSize = 500): AsyncGenerator<ExportedTimeline> {
  let after: Cursor | undefined;
  for (;;) {
    const conditions: SQL[] = [eq(timelines.projectId, projectId)];
    if (after) {
      conditions.push(
        sql`(${timelines.receivedAt}, ${timelines.id}) > (${after.receivedAt}::timestamp, ${after.id}::uuid)`
      );
    }
    const rows = await db
      .select({
        id: timelines.id,
        receivedAt: isoTimestamp(timelines.receivedAt),
        sessionId: timelines.sessionId,
        reasonType: timelines.reasonType,
        reason: timelines.reason,
        events: timelines.events,
        meta: timelines.meta,
        tags: timelines.tags,
      })
      .from(timelines)
      .where(whereAll(conditions))
      .orderBy(asc(timelines.receivedAt), asc(timelines.id))
      .limit(batchSize);
    yield* rows;
    if (rows.length < batchSize) {
      return;
    }
    const last = rows[rows.length - 1];
    after = { receivedAt: last.receivedAt, id: last.id };
  }
}
