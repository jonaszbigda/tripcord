import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client";
import type { User } from "../db/schema";
import { listUserOrgs, type UserOrg } from "../db/orgs";
import { currentUser, requireUser } from "../auth/http";
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
}
