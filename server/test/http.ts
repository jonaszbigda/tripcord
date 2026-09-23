import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/app";
import type { Database } from "../src/db/client";

/** buildApp's default publicUrl; non-GET /api requests must send it as Origin. */
export const TEST_ORIGIN = "http://localhost:3000";

export function buildTestApp(db: Database, options: AppOptions = {}): Promise<FastifyInstance> {
  return buildApp(db, { logLevel: "silent", ...options });
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface CallOptions {
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

// app.inject with what a same-origin browser request would carry: an Origin on
// non-GET requests, the session cookie, and a JSON body (inject sets the JSON
// content type for object payloads; body-less requests get no content type).
export function call(app: FastifyInstance, method: Method, url: string, options: CallOptions = {}) {
  return app.inject({
    method,
    url,
    headers: {
      ...(method === "GET" ? {} : { origin: TEST_ORIGIN }),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
}
