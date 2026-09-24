import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TimelinePayload } from "@tripcord/js";
import type { Database } from "../db/client";
import type { Project } from "../db/schema";
import { findProjectByApiKey } from "../db/projects";
import { FailureLimiter } from "../failure-limiter";
import { timelines } from "../db/schema";
import { rateLimitErrorBody } from "../rate-limit";
import { MAX_TAGS, tagSchema } from "../tags";

declare module "fastify" {
  interface FastifyRequest {
    project?: Project;
  }
}

const timelineEventSchema = {
  type: "object",
  required: ["timestamp", "type", "name"],
  properties: {
    timestamp: { type: "number" },
    type: { type: "string", enum: ["custom", "error", "unhandledrejection", "trace"] },
    name: { type: "string" },
    data: { type: "object" },
  },
  additionalProperties: false,
} as const;

const timelineReasonSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["error", "unhandledrejection", "manual"] },
    message: { type: "string" },
    name: { type: "string" },
    data: { type: "object" },
  },
  additionalProperties: false,
} as const;

const timelineMetaSchema = {
  type: "object",
  required: ["url", "userAgent", "capturedAt"],
  properties: {
    url: { type: "string" },
    userAgent: { type: "string" },
    capturedAt: { type: "number" },
  },
  additionalProperties: false,
} as const;

const timelinePayloadSchema = {
  type: "object",
  required: ["sessionId", "reason", "events", "meta"],
  properties: {
    sessionId: { type: "string" },
    reason: timelineReasonSchema,
    events: { type: "array", items: timelineEventSchema },
    meta: timelineMetaSchema,
    tags: { type: "array", maxItems: MAX_TAGS, uniqueItems: true, items: tagSchema },
  },
  additionalProperties: false,
} as const;

export interface TimelineRouteOptions {
  rateLimitMax: number;
  rateLimitWindow: string;
  /** Requests with an unknown or revoked key allowed per IP per minute. */
  invalidKeyLimitMax: number;
}

export function registerTimelineRoute(app: FastifyInstance, db: Database, options: TimelineRouteOptions): void {
  // The per-project rate limit below needs a resolved project, so it can't see
  // bad-key requests. This limits those per IP, and turns them away before the
  // key lookup so a flood of them doesn't reach the database.
  const invalidKeys = new FailureLimiter(options.invalidKeyLimitMax, 60_000);

  // Registered under the /v1 prefix in app.ts.
  app.post<{ Body: TimelinePayload }>(
    "/timeline",
    {
      schema: { body: timelinePayloadSchema },
      preValidation: async (request: FastifyRequest, reply) => {
        const apiKey = request.headers["x-tripcord-key"];
        if (typeof apiKey !== "string") {
          return reply.code(401).send({ error: "Missing X-Tripcord-Key header" });
        }
        const retryInMs = invalidKeys.blockedFor(request.ip);
        if (retryInMs > 0) {
          const seconds = Math.ceil(retryInMs / 1000);
          return reply
            .code(429)
            .header("retry-after", String(seconds))
            .send({ error: `Too many invalid API key attempts, retry in ${seconds} seconds` });
        }
        const project = await findProjectByApiKey(db, apiKey);
        if (!project) {
          invalidKeys.recordFailure(request.ip);
          return reply.code(401).send({ error: "Invalid API key" });
        }
        request.project = project;
      },
      config: {
        rateLimit: {
          max: options.rateLimitMax,
          timeWindow: options.rateLimitWindow,
          hook: "preHandler",
          keyGenerator: (request: FastifyRequest) => (request.project as Project).id,
          errorResponseBuilder: rateLimitErrorBody,
        },
      },
    },
    async (request, reply) => {
      const project = request.project as Project;
      const [row] = await db
        .insert(timelines)
        .values({
          projectId: project.id,
          sessionId: request.body.sessionId,
          reasonType: request.body.reason.type,
          reason: request.body.reason,
          events: request.body.events,
          meta: request.body.meta,
          tags: request.body.tags ?? [],
        })
        .returning({ id: timelines.id });

      return reply.code(201).send({ id: row.id });
    }
  );
}
