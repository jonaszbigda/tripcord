import type { FastifyInstance } from "fastify";
import { acceptInvite } from "../accounts";
import { currentUser, requireUser } from "../auth/http";
import { findUsableInvite } from "../db/invites";
import type { ApiContext } from "./context";
import { httpError } from "./errors";

// Used, revoked and expired invites all get this, so the response doesn't say which.
const INVITE_NOT_FOUND = "Invite not found or expired";

type TokenParams = { token: string };

export function registerInviteRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  // Public, so the invite page can show "Join <org>" before the visitor logs in.
  app.get<{ Params: TokenParams }>("/api/invites/:token", async (request) => {
    const invite = await findUsableInvite(db, request.params.token);
    if (!invite) {
      throw httpError(404, INVITE_NOT_FOUND);
    }
    return { orgName: invite.orgName, role: invite.role };
  });

  app.post<{ Params: TokenParams }>(
    "/api/invites/:token/accept",
    { preValidation: requireUser(db) },
    async (request) => {
      const result = await acceptInvite(db, request.params.token, currentUser(request).id);
      if (!result.ok) {
        throw result.reason === "already_member" ? httpError(409, "Already a member") : httpError(404, INVITE_NOT_FOUND);
      }
      return { orgId: result.orgId };
    }
  );
}
