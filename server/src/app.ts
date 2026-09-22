import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "./db/client";

export function buildApp(db: Database): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });

  app.get("/health", async () => {
    return { status: "ok" };
  });

  // Task 7 registers POST /v1/timeline onto this same `app`, using `db`.
  void db;

  return app;
}
