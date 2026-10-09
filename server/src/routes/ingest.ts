import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TimelineEvent, TimelineMeta, TimelinePayload } from "@tripcord/js";
import type { Database } from "../db/client";
import type { Project } from "../db/schema";
import { findProjectByApiKey } from "../db/projects";
import { bakeCapture, ensureTimelineSession, stageEvents } from "../db/timeline-sessions";
import { FailureLimiter } from "../failure-limiter";
import { rateLimitErrorBody } from "../rate-limit";
import { MAX_TAGS, tagSchema } from "../tags";

declare module "fastify" {
  interface FastifyRequest {
    project?: Project;
  }
}

const SESSION_ID = { type: "string", minLength: 1, maxLength: 200 } as const;

const timelineEventSchema = {
  type: "object",
  required: ["timestamp", "type", "name"],
  properties: {
    id: { type: "string", maxLength: 200 },
    source: { type: "string", maxLength: 40 },
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
    sessionId: SESSION_ID,
    reason: timelineReasonSchema,
    events: { type: "array", items: timelineEventSchema },
    meta: timelineMetaSchema,
    tags: { type: "array", maxItems: MAX_TAGS, uniqueItems: true, items: tagSchema },
  },
  additionalProperties: false,
} as const;

const eventsPayloadSchema = {
  type: "object",
  required: ["sessionId", "events"],
  properties: {
    sessionId: SESSION_ID,
    events: { type: "array", minItems: 1, maxItems: 1000, items: timelineEventSchema },
  },
  additionalProperties: false,
} as const;

const sessionMintSchema = { type: "object", additionalProperties: false } as const;

export interface IngestRouteOptions {
  rateLimitMax: number;
  rateLimitWindow: string;
  /** Requests with an unknown or revoked key allowed per IP per minute. */
  invalidKeyLimitMax: number;
}

/** The key from either supported header, or undefined. */
export function readApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const header = headers["x-tripcord-key"];
  if (typeof header === "string" && header.length > 0) {
    return header;
  }
  const authorization = headers["authorization"];
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    return token.length > 0 ? token : undefined;
  }
  return undefined;
}

/** Stamps a missing source; the endpoint knows which side it is usually talking to. */
function withSource(events: TimelineEvent[], fallback: string): TimelineEvent[] {
  return events.map((event) => (event.source ? event : { ...event, source: fallback }));
}

export function registerIngestRoutes(app: FastifyInstance, db: Database, options: IngestRouteOptions): void {
  // One limiter for every ingest route: a bad key is a bad key whichever
  // endpoint it hits. It runs before the lookup, so a flood of bad keys doesn't
  // reach the database.
  const invalidKeys = new FailureLimiter(options.invalidKeyLimitMax, 60_000);

  const preValidation = async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = readApiKey(request.headers);
    if (apiKey === undefined) {
      return reply.code(401).send({ error: "Missing API key" });
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
  };

  const rateLimit = {
    max: options.rateLimitMax,
    timeWindow: options.rateLimitWindow,
    hook: "preHandler" as const,
    keyGenerator: (request: FastifyRequest) => (request.project as Project).id,
    errorResponseBuilder: rateLimitErrorBody,
  };

  // Registered under the /v1 prefix in app.ts.
  app.post<{ Body: TimelinePayload }>(
    "/timeline",
    { schema: { body: timelinePayloadSchema }, preValidation, config: { rateLimit } },
    async (request, reply) => {
      const project = request.project as Project;
      const meta = request.body.meta as TimelineMeta;
      const capture = await bakeCapture(db, project.id, {
        sessionId: request.body.sessionId,
        reason: request.body.reason,
        events: withSource(request.body.events, "browser"),
        meta,
        tags: request.body.tags ?? [],
        // Clamp a clock-skewed future timestamp, but keep a backdated one: a
        // capture can describe a moment from days ago.
        occurredAt: new Date(Math.min(Date.now(), meta.capturedAt)),
      });
      return reply.code(201).send({ id: capture.id, sessionId: request.body.sessionId, eventCount: capture.eventCount });
    }
  );

  app.post<{ Body: { sessionId: string; events: TimelineEvent[] } }>(
    "/events",
    { schema: { body: eventsPayloadSchema }, preValidation, config: { rateLimit } },
    async (request, reply) => {
      const project = request.project as Project;
      const staged = await stageEvents(db, project.id, request.body.sessionId, withSource(request.body.events, "server"));
      return reply.code(202).send({ sessionId: request.body.sessionId, staged });
    }
  );

  app.post(
    "/sessions",
    { schema: { body: sessionMintSchema }, preValidation, config: { rateLimit } },
    async (request, reply) => {
      const project = request.project as Project;
      const sessionId = randomUUID();
      await ensureTimelineSession(db, project.id, sessionId);
      return reply.code(201).send({ sessionId });
    }
  );
}
