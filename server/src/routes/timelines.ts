import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { requireMembership, requireUser } from "../auth/http";
import {
  decodeCursor,
  exportTimelines,
  getTimeline,
  listTags,
  listTimelines,
  RANGES,
  REASON_TYPES,
  summarizeTimelines,
  type Range,
  type ReasonType,
  type TimelineFilters,
} from "../db/timelines";
import { MAX_TAGS, tagSchema } from "../tags";
import { isUuid } from "../uuid";
import type { ApiContext } from "./context";
import { httpError } from "./errors";
import { requireProject, type ProjectParams } from "./projects";

interface FilterQuery {
  range: Range;
  reasonType?: ReasonType[];
  tag?: string[];
  reason?: string;
}

const rangeSchema = { type: "string", enum: Object.keys(RANGES), default: "7d" };

// Arrays because Fastify's Ajv coerces a single ?tag=a into ["a"].
const filterProperties = {
  range: rangeSchema,
  reasonType: { type: "array", maxItems: REASON_TYPES.length, items: { type: "string", enum: REASON_TYPES } },
  tag: { type: "array", maxItems: MAX_TAGS, items: tagSchema },
  reason: { type: "string", pattern: "^[0-9a-f]{32}$" },
};

function querySchema(properties: Record<string, unknown>) {
  return { type: "object", properties, additionalProperties: false };
}

const TIME_ZONE_SHAPE = /^[A-Za-z0-9_+\-/]{1,64}$/;

// Intl validates against the same IANA database Postgres uses. The shape check
// keeps anything else (POSIX zone strings, SQL) away from AT TIME ZONE.
export function isTimeZone(value: string): boolean {
  if (!TIME_ZONE_SHAPE.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** e.g. "web-shop-2026-09-24.ndjson". */
export function exportFilename(projectName: string, date: Date): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project";
  return `${slug}-${date.toISOString().slice(0, 10)}.ndjson`;
}

async function* ndjson(rows: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const row of rows) {
    yield `${JSON.stringify(row)}\n`;
  }
}

function filtersFrom(query: FilterQuery): TimelineFilters {
  return { range: query.range, reasonTypes: query.reasonType ?? [], tags: query.tag ?? [], reason: query.reason };
}

// Read-only, for owners and members alike. preValidation (auth) runs before the
// querystring is validated, so a non-member gets 404 even with a bad query.
export function registerTimelineReadRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const asMember = [requireUser(db, ctx.emailVerification), requireMembership(db, "member")];
  const base = "/api/orgs/:orgId/projects/:projectId/timelines";

  app.get<{ Params: ProjectParams; Querystring: FilterQuery & { cursor?: string; limit: number } }>(
    base,
    {
      preValidation: asMember,
      schema: {
        querystring: querySchema({
          ...filterProperties,
          cursor: { type: "string", maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        }),
      },
    },
    async (request) => {
      await requireProject(db, request.params);
      const { cursor, limit } = request.query;
      const decoded = cursor === undefined ? undefined : decodeCursor(cursor);
      if (cursor !== undefined && !decoded) {
        throw httpError(400, "Invalid cursor");
      }
      return listTimelines(db, request.params.projectId, filtersFrom(request.query), { cursor: decoded, limit });
    }
  );

  app.get<{ Params: ProjectParams; Querystring: FilterQuery & { tz: string } }>(
    `${base}/summary`,
    {
      preValidation: asMember,
      schema: { querystring: querySchema({ ...filterProperties, tz: { type: "string", default: "UTC" } }) },
    },
    async (request) => {
      await requireProject(db, request.params);
      if (!isTimeZone(request.query.tz)) {
        throw httpError(400, "Invalid time zone");
      }
      return summarizeTimelines(db, request.params.projectId, filtersFrom(request.query), request.query.tz);
    }
  );

  app.get<{ Params: ProjectParams; Querystring: { range: Range } }>(
    `${base}/tags`,
    { preValidation: asMember, schema: { querystring: querySchema({ range: rangeSchema }) } },
    async (request) => {
      await requireProject(db, request.params);
      return { tags: await listTags(db, request.params.projectId, request.query.range) };
    }
  );

  // Streamed, so a large project never sits in memory. Any member may export.
  app.get<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/export",
    { preValidation: asMember },
    async (request, reply) => {
      const project = await requireProject(db, request.params);
      return reply
        .header("Content-Type", "application/x-ndjson; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${exportFilename(project.name, new Date())}"`)
        .send(Readable.from(ndjson(exportTimelines(db, project.id))));
    }
  );

  app.get<{ Params: ProjectParams & { timelineId: string } }>(
    `${base}/:timelineId`,
    { preValidation: asMember },
    async (request) => {
      await requireProject(db, request.params);
      const { projectId, timelineId } = request.params;
      const found = isUuid(timelineId) ? await getTimeline(db, projectId, timelineId) : undefined;
      if (!found) {
        throw httpError(404, "Not Found");
      }
      return found;
    }
  );
}
