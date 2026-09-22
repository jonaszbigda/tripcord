import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Database } from "./db/client";
import { registerTimelineRoute } from "./routes/timeline";

export interface AppOptions {
  rateLimitMax?: number;
  rateLimitWindow?: string;
  bodyLimit?: number;
  logLevel?: string;
}

export async function buildApp(db: Database, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? "info" },
    bodyLimit: options.bodyLimit ?? 256 * 1024,
  });

  await app.register(rateLimit, { global: false });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerTimelineRoute(app, db, {
    rateLimitMax: options.rateLimitMax ?? 100,
    rateLimitWindow: options.rateLimitWindow ?? "1 minute",
  });

  return app;
}
