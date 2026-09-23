import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE, clearSessionCookie } from "../auth/http";
import { deleteSession } from "../db/sessions";
import { countUsers } from "../db/users";
import type { ApiContext } from "./context";

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  // Drives the login/signup UI: whether to offer signup and a GitHub button.
  app.get("/api/auth/config", async () => ({
    signup: ctx.signup,
    bootstrapped: (await countUsers(db)) > 0,
    github: ctx.github !== undefined,
  }));

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await deleteSession(db, token);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
