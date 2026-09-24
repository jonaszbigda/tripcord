import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client";
import type { User } from "../db/schema";
import { listUserOrgs, type UserOrg } from "../db/orgs";
import { clearSessionCookie, currentUser, requireUser } from "../auth/http";
import { hashPassword, verifyPassword } from "../auth/password";
import { deleteUserSessions } from "../db/sessions";
import { setGithubId, setPasswordHash } from "../db/users";
import { deleteUser } from "../deletion";
import { authRateLimit } from "./auth";
import type { ApiContext } from "./context";

export interface MeBody {
  user: { id: string; email: string; name: string; hasPassword: boolean; githubConnected: boolean };
  orgs: UserOrg[];
}

// Also the response body of signup and login, so the SPA can seed its cache.
export async function meBody(db: Database, user: User): Promise<MeBody> {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      hasPassword: user.passwordHash !== null,
      githubConnected: user.githubId !== null,
    },
    orgs: await listUserOrgs(db, user.id),
  };
}

export function registerMeRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get("/api/me", { preValidation: requireUser(db) }, async (request) => meBody(db, currentUser(request)));

  app.post<{ Body: { currentPassword?: string; newPassword: string } }>(
    "/api/me/password",
    {
      preValidation: requireUser(db),
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
      preValidation: requireUser(db),
      schema: {
        body: {
          type: "object",
          properties: { password: { type: "string", maxLength: 256 } },
          additionalProperties: false,
        },
      },
      config: { rateLimit: authRateLimit(ctx) },
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

  app.delete("/api/me/github", { preValidation: requireUser(db) }, async (request, reply) => {
    const user = currentUser(request);
    if (user.passwordHash === null) {
      return reply.code(409).send({ error: "Set a password before disconnecting GitHub" });
    }
    await setGithubId(db, user.id, null);
    return reply.code(204).send();
  });
}
