import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { Database } from "./db/client";
import { registerTimelineRoute } from "./routes/timeline";

export interface AppOptions {
  rateLimitMax?: number;
  rateLimitWindow?: string;
  bodyLimit?: number;
  logLevel?: string;
}

// @fastify/rate-limit's errorResponseBuilder in timeline.ts throws a plain
// object shaped like `{ error: string }` (with a non-enumerable
// `statusCode`), not an Error. This narrows to that shape so the global
// error handler can forward it as-is instead of reading `.message` off it.
function isPreShapedErrorBody(err: unknown): err is { error: string; statusCode?: number } {
  return typeof err === "object" && err !== null && typeof (err as Record<string, unknown>).error === "string";
}

export async function buildApp(db: Database, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" },
    bodyLimit: options.bodyLimit ?? 256 * 1024,
    // Fastify's ajv default silently deletes properties that fail
    // `additionalProperties: false` instead of failing validation. We want
    // unknown fields to be rejected (400), not quietly stripped, so turn
    // that default off globally.
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  });

  // The browser client sends `Content-Type: application/json` plus a custom
  // `X-Repro-Key` header, which makes every request CORS-preflighted. The
  // API key in `X-Repro-Key` is this API's only auth boundary — there are no
  // cookies/credentialed requests to protect — so an open origin policy is
  // appropriate here.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Repro-Key"],
  });

  await app.register(rateLimit, { global: false });

  // Global error shape: every 4xx/5xx response is `{ error: "message" }`.
  //
  // The 401 responses in timeline.ts's preValidation hook already send this
  // shape directly via `reply.code(...).send(...)` and return before
  // Fastify's error-handling machinery runs, so this handler never sees
  // those.
  //
  // The 429 path is different: @fastify/rate-limit's `errorResponseBuilder`
  // (configured in timeline.ts) builds `{ error: "..." }` and *throws* it —
  // it does not call reply.send() itself — so it DOES reach this handler.
  // That thrown value is a plain object, not an Error, so it has no
  // `.message`; it's already in the exact final shape we want, just under
  // `.error` instead of `.message`. Detect that shape and forward it as-is
  // instead of trying to read `.message` off it (which would be
  // `undefined` and produce `{}` on the wire).
  app.setErrorHandler((err: FastifyError, request, reply) => {
    if (isPreShapedErrorBody(err)) {
      reply.code(err.statusCode ?? 500).send({ error: err.error });
      return;
    }

    const statusCode = err.statusCode ?? 500;

    if (statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({ error: err.message });
      return;
    }

    // Never leak internal error details (e.g. a raw Postgres error message)
    // to the client on a 500 — log it server-side instead.
    request.log.error(err);
    reply.code(statusCode >= 500 ? statusCode : 500).send({ error: "Internal Server Error" });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: "Not Found" });
  });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerTimelineRoute(app, db, {
    rateLimitMax: options.rateLimitMax ?? 100,
    rateLimitWindow: options.rateLimitWindow ?? "1 minute",
  });

  return app;
}
