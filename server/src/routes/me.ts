import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "../db/client";
import type { User } from "../db/schema";
import { listUserOrgs, type UserOrg } from "../db/orgs";
import { clearSessionCookie, currentUser, requireUser } from "../auth/http";
import { hashPassword, verifyPassword } from "../auth/password";
import { deleteUserSessions } from "../db/sessions";
import { normalizeEmail, setGithubId, setPasswordHash } from "../db/users";
import { deleteUser } from "../deletion";
import { changeUnverifiedEmail, sendVerification, type ChangeEmailResult } from "../email-verification";
import { authRateLimit, EMAIL_PATTERN } from "./auth";
import type { ApiContext } from "./context";

export interface MeBody {
  user: {
    id: string;
    email: string;
    name: string;
    hasPassword: boolean;
    githubConnected: boolean;
    /** False only while verification is active and the user hasn't verified. */
    emailVerified: boolean;
  };
  orgs: UserOrg[];
}

// Also the response body of signup and login, so the SPA can seed its cache.
export async function meBody(db: Database, user: User, emailVerification: boolean): Promise<MeBody> {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      hasPassword: user.passwordHash !== null,
      githubConnected: user.githubId !== null,
      emailVerified: !emailVerification || user.emailVerifiedAt !== null,
    },
    orgs: await listUserOrgs(db, user.id),
  };
}

// Shared by resend and change-email. A send failure is logged and still
// answers 204: the link exists, and the user can resend after the cooldown.
function sendResultReply(reply: FastifyReply, result: ChangeEmailResult, alreadyVerifiedStatus: 403 | 409) {
  switch (result.status) {
    case "sent":
      return reply.code(204).send();
    case "already_verified":
      return reply.code(alreadyVerifiedStatus).send({ error: "Email already verified" });
    case "email_taken":
      return reply.code(409).send({ error: "Email already registered" });
    case "throttled":
      return reply.code(429).send({ error: "Too many verification emails", retryAfterSeconds: result.retryAfterSeconds });
  }
}

export function registerMeRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get(
    "/api/me",
    { preValidation: requireUser(db, ctx.emailVerification), config: { allowUnverified: true } },
    async (request) => meBody(db, currentUser(request), ctx.emailVerification)
  );

  app.post<{ Body: { currentPassword?: string; newPassword: string } }>(
    "/api/me/password",
    {
      preValidation: requireUser(db, ctx.emailVerification),
      schema: {
        body: {
          type: "object",
          required: ["newPassword"],
          properties: {
            currentPassword: { type: "string", maxLength: 256 },
            newPassword: { type: "string", minLength: 8, maxLength: 256 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      // A GitHub-only user has no password yet and may set one without it.
      if (user.passwordHash !== null) {
        const { currentPassword } = request.body;
        if (currentPassword === undefined || !(await verifyPassword(currentPassword, user.passwordHash))) {
          return reply.code(403).send({ error: "Current password is incorrect" });
        }
      }
      await setPasswordHash(db, user.id, await hashPassword(request.body.newPassword));
      await deleteUserSessions(db, user.id, { except: request.sessionToken });
      return reply.code(204).send();
    }
  );

  // The dashboard always sends a body ({} for GitHub-only users), which the schema requires.
  app.delete<{ Body: { password?: string } }>(
    "/api/me",
    {
      preValidation: requireUser(db, ctx.emailVerification),
      schema: {
        body: {
          type: "object",
          properties: { password: { type: "string", maxLength: 256 } },
          additionalProperties: false,
        },
      },
      config: { rateLimit: authRateLimit(ctx), allowUnverified: true },
    },
    async (request, reply) => {
      const user = currentUser(request);
      if (user.passwordHash !== null && !(await verifyPassword(request.body.password ?? "", user.passwordHash))) {
        return reply.code(403).send({ error: "Password is incorrect" });
      }
      const result = await deleteUser(db, user.id);
      if (!result.ok) {
        return reply.code(409).send({ error: "You're the only owner of an org with other members", orgs: result.orgs });
      }
      clearSessionCookie(reply);
      return reply.code(204).send();
    }
  );

  app.delete("/api/me/github", { preValidation: requireUser(db, ctx.emailVerification) }, async (request, reply) => {
    const user = currentUser(request);
    if (user.passwordHash === null) {
      return reply.code(409).send({ error: "Set a password before disconnecting GitHub" });
    }
    await setGithubId(db, user.id, null);
    return reply.code(204).send();
  });

  const { mailer } = ctx;
  if (!ctx.emailVerification || !mailer) {
    return;
  }
  const unverifiedRoute = {
    preValidation: requireUser(db, true),
    config: { rateLimit: authRateLimit(ctx), allowUnverified: true },
  };

  app.post("/api/me/verify-email/resend", unverifiedRoute, async (request, reply) => {
    const user = currentUser(request);
    try {
      return sendResultReply(reply, await sendVerification(db, mailer, ctx.publicUrl, user), 409);
    } catch (error) {
      request.log.error({ err: error, userId: user.id }, "verification email failed");
      return reply.code(204).send();
    }
  });

  app.patch<{ Body: { email: string } }>(
    "/api/me/email",
    {
      ...unverifiedRoute,
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", maxLength: 254 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_PATTERN.test(email)) {
        return reply.code(400).send({ error: "Invalid email" });
      }
      try {
        return sendResultReply(reply, await changeUnverifiedEmail(db, mailer, ctx.publicUrl, user, email), 403);
      } catch (error) {
        request.log.error({ err: error, userId: user.id }, "verification email failed");
        return reply.code(204).send();
      }
    }
  );
}
