import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { SignupMode } from "./accounts";
import type { GithubConfig } from "./config";
import type { Database } from "./db/client";
import type { Mailer } from "./email";
import { isEmailVerificationActive } from "./email-verification";
import { redactTokens } from "./redact";
import { csrfGuard } from "./auth/http";
import type { ApiContext } from "./routes/context";
import { registerAuthRoutes } from "./routes/auth";
import { registerGithubRoutes } from "./routes/github";
import { registerInviteRoutes } from "./routes/invites";
import { registerMeRoutes } from "./routes/me";
import { registerOrgRoutes } from "./routes/orgs";
import { registerPasswordResetRoutes } from "./routes/password-reset";
import { registerProjectRoutes } from "./routes/projects";
import { registerTimelineRoute } from "./routes/timeline";
import { registerTimelineReadRoutes } from "./routes/timelines";
import { SERVER_VERSION } from "./version";

export interface AppOptions {
  rateLimitMax?: number;
  rateLimitWindow?: string;
  /** Ingest requests with an unknown or revoked key allowed per IP per minute. Default 30. */
  invalidKeyLimitMax?: number;
  bodyLimit?: number;
  logLevel?: string;
  /** Where logs go. Default stdout; tests pass a stream to read them. */
  logStream?: { write(line: string): void };
  /** External URL of the dashboard, e.g. https://app.tripcord.dev. Default http://localhost:3000. */
  publicUrl?: string;
  /** Default "invite-only". */
  signup?: SignupMode;
  /** GitHub login is enabled only when set. */
  github?: GithubConfig;
  /** fetch used for GitHub API calls; tests pass a stub. Default: global fetch. */
  githubFetch?: typeof fetch;
  /** Fastify trustProxy, so rate limits see real client IPs behind a proxy. */
  trustProxy?: boolean;
  /** Built dashboard to serve at /. Not served when unset or missing. */
  dashboardDir?: string;
  /** Sends email. Password reset is enabled only when set. */
  mailer?: Mailer;
  /** Per-IP login and signup attempts per minute. Default 10. */
  authRateLimitMax?: number;
  /** Called for every registered route; the tenant-isolation test enumerates routes with it. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

// @fastify/rate-limit's errorResponseBuilder (see rate-limit.ts) throws a plain
// object shaped like `{ error: string }` (with a non-enumerable `statusCode`),
// not an Error. This narrows to that shape so the global error handler can
// forward it as-is instead of reading `.message` off it.
function isPreShapedErrorBody(err: unknown): err is { error: string; statusCode?: number } {
  return typeof err === "object" && err !== null && typeof (err as Record<string, unknown>).error === "string";
}

function isBackendPath(url: string): boolean {
  const pathname = url.split("?")[0];
  return /^\/(api|v1)(\/|$)/.test(pathname) || pathname === "/health";
}

export async function buildApp(db: Database, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? "info",
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Replaces the default, which logs the client's IP and port. The privacy
      // page promises no IPs in logs; rate limiters use them in memory only.
      serializers: {
        req: (request: { method: string; url: string }) => ({ method: request.method, url: redactTokens(request.url) }),
      },
    },
    bodyLimit: options.bodyLimit ?? 256 * 1024,
    trustProxy: options.trustProxy ?? false,
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

  if (options.onRoute) {
    const onRoute = options.onRoute;
    app.addHook("onRoute", (route) => onRoute({ method: route.method, url: route.url }));
  }

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Global error shape: every 4xx/5xx response is `{ error: "message" }`.
  //
  // Hooks that reply directly (401s in timeline.ts and auth/http.ts, 403s in
  // csrfGuard) send this shape themselves and never reach this handler.
  //
  // The 429 path is different: @fastify/rate-limit's `errorResponseBuilder`
  // builds `{ error: "..." }` and *throws* it, so it DOES reach this handler.
  // That thrown value is a plain object, not an Error, so it has no
  // `.message`; it's already in the exact final shape we want, just under
  // `.error` instead of `.message`. Detect that shape and forward it as-is.
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

  const spaDir =
    options.dashboardDir && existsSync(path.join(options.dashboardDir, "index.html"))
      ? path.resolve(options.dashboardDir)
      : undefined;
  if (spaDir) {
    await app.register(fastifyStatic, { root: spaDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    // Client-side routes (/orgs/..., /invite/...) have no file on disk; serve
    // the SPA shell so a reload or a pasted link works.
    if (spaDir && request.method === "GET" && !isBackendPath(request.url)) {
      return reply.type("text/html").sendFile("index.html");
    }
    reply.code(404).send({ error: "Not Found" });
  });

  const publicUrl = new URL(options.publicUrl ?? "http://localhost:3000").origin;
  app.addHook("onRequest", csrfGuard(publicUrl));

  app.get("/health", async () => {
    return { status: "ok", version: SERVER_VERSION };
  });

  // Ingest is called cross-origin from customers' sites and authenticates with
  // X-Tripcord-Key alone, so it gets an open CORS policy. That policy lives in
  // this /v1-prefixed plugin so it never applies to the cookie-authenticated
  // /api routes, which must not be readable cross-origin.
  await app.register(
    async (v1) => {
      await v1.register(cors, {
        origin: true,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "X-Tripcord-Key"],
      });
      registerTimelineRoute(v1, db, {
        rateLimitMax: options.rateLimitMax ?? 100,
        rateLimitWindow: options.rateLimitWindow ?? "1 minute",
        invalidKeyLimitMax: options.invalidKeyLimitMax ?? 30,
      });
    },
    { prefix: "/v1" }
  );

  const signup = options.signup ?? "invite-only";
  const ctx: ApiContext = {
    db,
    publicUrl,
    secureCookies: publicUrl.startsWith("https:"),
    signup,
    github: options.github,
    githubFetch: options.githubFetch ?? fetch,
    authRateLimitMax: options.authRateLimitMax ?? 10,
    mailer: options.mailer,
    emailVerification: isEmailVerificationActive(signup, options.mailer !== undefined),
  };
  registerAuthRoutes(app, ctx);
  registerPasswordResetRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  registerOrgRoutes(app, ctx);
  registerInviteRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerTimelineReadRoutes(app, ctx);
  registerGithubRoutes(app, ctx);

  return app;
}
