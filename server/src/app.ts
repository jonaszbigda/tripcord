import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/client";
import { registerTimelineRoute } from "./routes/timeline";

export function buildApp(db: Database): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerTimelineRoute(app, db);

  return app;
}
