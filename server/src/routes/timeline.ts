import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TimelinePayload } from "@repro/js";
import type { Database } from "../db/client";
import type { Project } from "../db/schema";
import { findProjectByApiKey } from "../db/projects";
import { timelines } from "../db/schema";

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
  },
  additionalProperties: false,
} as const;

export interface TimelineRouteOptions {
  rateLimitMax: number;
  rateLimitWindow: string;
}

export function registerTimelineRoute(app: FastifyInstance, db: Database, options: TimelineRouteOptions): void {
  app.post<{ Body: TimelinePayload }>(
    "/v1/timeline",
    {
      schema: { body: timelinePayloadSchema },
      preValidation: async (request: FastifyRequest, reply) => {
        const apiKey = request.headers["x-repro-key"];
        if (typeof apiKey !== "string") {
          return reply.code(401).send({ error: "Missing X-Repro-Key header" });
        }
        const project = await findProjectByApiKey(db, apiKey);
        if (!project) {
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
          errorResponseBuilder: (_request, context) => {
            const body = { error: `Rate limit exceeded, retry in ${context.after}` };
            // @fastify/rate-limit throws this object and Fastify reads `.statusCode`
            // off it to set the reply status. Define it non-enumerable so it drives
            // the status code without leaking into the JSON body.
            Object.defineProperty(body, "statusCode", {
              value: context.statusCode,
              enumerable: false,
            });
            return body;
          },
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
        })
        .returning({ id: timelines.id });

      return reply.code(201).send({ id: row.id });
    }
  );
}
