import type { FastifyInstance } from "fastify";
import { currentMembership, currentUser, requireMembership, requireUser } from "../auth/http";
import { createInvite, listPendingInvites, revokeInvite } from "../db/invites";
import { changeRole, createOrgWithOwner, listMembers, removeMember, renameOrg, type MembershipChange } from "../db/orgs";
import { ROLES, type Role } from "../db/schema";
import { deleteOrg } from "../deletion";
import { isUuid } from "../uuid";
import type { ApiContext } from "./context";
import { httpError, requireName } from "./errors";

export const nameBodySchema = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string", maxLength: 100 } },
  additionalProperties: false,
} as const;

const roleBodySchema = {
  type: "object",
  required: ["role"],
  properties: { role: { type: "string", enum: [...ROLES] } },
  additionalProperties: false,
} as const;

type OrgParams = { orgId: string };
type MemberParams = { orgId: string; userId: string };

const MEMBERSHIP_ERRORS = {
  not_found: [404, "Not Found"],
  last_owner: [409, "An org must have at least one owner"],
} as const;

function membershipError(result: Extract<MembershipChange, { ok: false }>) {
  const [status, error] = MEMBERSHIP_ERRORS[result.reason];
  return httpError(status, error);
}

export function registerOrgRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const asMember = [requireUser(db), requireMembership(db, "member")];
  const asOwner = [requireUser(db), requireMembership(db, "owner")];

  app.post<{ Body: { name: string } }>(
    "/api/orgs",
    { preValidation: requireUser(db), schema: { body: nameBodySchema } },
    async (request, reply) => {
      const name = requireName(request.body.name, "Org name");
      const org = await createOrgWithOwner(db, currentUser(request).id, name);
      return reply.code(201).send({ id: org.id, name: org.name, role: "owner" });
    }
  );

  app.patch<{ Params: OrgParams; Body: { name: string } }>(
    "/api/orgs/:orgId",
    { preValidation: asOwner, schema: { body: nameBodySchema } },
    async (request) => {
      const org = await renameOrg(db, request.params.orgId, requireName(request.body.name, "Org name"));
      if (!org) {
        throw httpError(404, "Not Found");
      }
      return { id: org.id, name: org.name };
    }
  );

  app.delete<{ Params: OrgParams }>("/api/orgs/:orgId", { preValidation: asOwner }, async (request, reply) => {
    await deleteOrg(db, request.params.orgId);
    return reply.code(204).send();
  });

  app.get<{ Params: OrgParams }>("/api/orgs/:orgId/members", { preValidation: asMember }, async (request) => ({
    members: await listMembers(db, request.params.orgId),
  }));

  app.patch<{ Params: MemberParams; Body: { role: Role } }>(
    "/api/orgs/:orgId/members/:userId",
    { preValidation: asOwner, schema: { body: roleBodySchema } },
    async (request) => {
      const { orgId, userId } = request.params;
      if (!isUuid(userId)) {
        throw httpError(404, "Not Found");
      }
      const result = await changeRole(db, orgId, userId, request.body.role);
      if (!result.ok) {
        throw membershipError(result);
      }
      return { userId, role: request.body.role };
    }
  );

  // Owners remove anyone; a member may only remove themself (leave the org).
  app.delete<{ Params: MemberParams }>(
    "/api/orgs/:orgId/members/:userId",
    { preValidation: asMember },
    async (request, reply) => {
      const { orgId, userId } = request.params;
      if (!isUuid(userId)) {
        throw httpError(404, "Not Found");
      }
      if (userId !== currentUser(request).id && currentMembership(request).role !== "owner") {
        throw httpError(403, "Forbidden");
      }
      const result = await removeMember(db, orgId, userId);
      if (!result.ok) {
        throw membershipError(result);
      }
      return reply.code(204).send();
    }
  );

  app.post<{ Params: OrgParams; Body: { role: Role } }>(
    "/api/orgs/:orgId/invites",
    { preValidation: asOwner, schema: { body: roleBodySchema } },
    async (request, reply) => {
      const { invite, token } = await createInvite(db, {
        orgId: request.params.orgId,
        role: request.body.role,
        createdBy: currentUser(request).id,
      });
      return reply.code(201).send({ invite, link: `${ctx.publicUrl}/invite/${token}` });
    }
  );

  app.get<{ Params: OrgParams }>("/api/orgs/:orgId/invites", { preValidation: asOwner }, async (request) => ({
    invites: await listPendingInvites(db, request.params.orgId),
  }));

  app.delete<{ Params: OrgParams & { inviteId: string } }>(
    "/api/orgs/:orgId/invites/:inviteId",
    { preValidation: asOwner },
    async (request, reply) => {
      const { orgId, inviteId } = request.params;
      if (!isUuid(inviteId) || !(await revokeInvite(db, orgId, inviteId))) {
        throw httpError(404, "Not Found");
      }
      return reply.code(204).send();
    }
  );
}
