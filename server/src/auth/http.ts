import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client";
import type { Membership, Role, User } from "../db/schema";
import { getMembership } from "../db/orgs";
import { createSession, findSessionUser } from "../db/sessions";
import { isUuid } from "../uuid";

export const SESSION_COOKIE = "tripcord_session";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by requireUser. */
    user?: User;
    /** The session cookie's token, set by requireUser. */
    sessionToken?: string;
    /** Set by requireMembership. */
    membership?: Membership;
  }
}

export async function startSession(db: Database, reply: FastifyReply, userId: string, secure: boolean): Promise<void> {
  const { token, expiresAt } = await createSession(db, userId);
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", expires: expiresAt });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

// Cookie-authenticated /api routes accept a state-changing request only from
// the dashboard's own origin. Browsers always send Origin on non-GET requests,
// and a cross-site HTML form can't produce an application/json body, so a
// forged request fails one of the two checks. Body-less requests carry no
// Content-Type, since Fastify rejects an empty body declared as JSON.
export function csrfGuard(publicOrigin: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      return;
    }
    if (!/^\/api(\/|\?|$)/.test(request.url)) {
      return;
    }
    if (request.headers.origin !== publicOrigin) {
      return reply.code(403).send({ error: "Cross-origin request blocked" });
    }
    const contentType = request.headers["content-type"];
    if (contentType !== undefined && !JSON_CONTENT_TYPE.test(contentType)) {
      return reply.code(403).send({ error: "Content-Type must be application/json" });
    }
  };
}

export function requireUser(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await findSessionUser(db, token) : undefined;
    if (!token || !user) {
      return reply.code(401).send({ error: "Not logged in" });
    }
    request.user = user;
    request.sessionToken = token;
  };
}

// Must run after requireUser. A non-member gets the same 404 as a nonexistent
// org, so org ids can't be probed; a member without the role gets 403.
export function requireMembership(db: Database, minRole: Role) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId } = request.params as { orgId?: string };
    const membership = orgId && isUuid(orgId) ? await getMembership(db, orgId, currentUser(request).id) : undefined;
    if (!membership) {
      return reply.code(404).send({ error: "Not Found" });
    }
    if (minRole === "owner" && membership.role !== "owner") {
      return reply.code(403).send({ error: "Forbidden" });
    }
    request.membership = membership;
  };
}

/** The logged-in user. Only valid in handlers behind requireUser. */
export function currentUser(request: FastifyRequest): User {
  if (!request.user) {
    throw new Error("requireUser did not run for this route");
  }
  return request.user;
}

/** The caller's membership of :orgId. Only valid in handlers behind requireMembership. */
export function currentMembership(request: FastifyRequest): Membership {
  if (!request.membership) {
    throw new Error("requireMembership did not run for this route");
  }
  return request.membership;
}
