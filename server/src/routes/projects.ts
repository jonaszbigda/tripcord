import type { FastifyInstance } from "fastify";
import { requireMembership, requireUser } from "../auth/http";
import type { Database } from "../db/client";
import type { Project } from "../db/schema";
import { deleteProject } from "../deletion";
import {
  createApiKey,
  createProject,
  findApiKeyInOrg,
  findProjectInOrg,
  listApiKeys,
  listProjects,
  revokeApiKey,
} from "../db/projects";
import { isUuid } from "../uuid";
import type { ApiContext } from "./context";
import { httpError, requireName } from "./errors";
import { nameBodySchema } from "./orgs";

type OrgParams = { orgId: string };
export type ProjectParams = OrgParams & { projectId: string };
type KeyParams = ProjectParams & { keyId: string };

/** 404 unless the project exists in the org. Every project-scoped route calls it first. */
export async function requireProject(db: Database, { orgId, projectId }: ProjectParams): Promise<Project> {
  const project = isUuid(projectId) ? await findProjectInOrg(db, orgId, projectId) : undefined;
  if (!project) {
    throw httpError(404, "Not Found");
  }
  return project;
}

// Key logic lives in db/projects.ts (shared with the CLI). These routes only add
// the tenant check: every project and key is looked up through :orgId first.
export function registerProjectRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const asMember = [requireUser(db), requireMembership(db, "member")];
  const asOwner = [requireUser(db), requireMembership(db, "owner")];

  app.get<{ Params: OrgParams }>("/api/orgs/:orgId/projects", { preValidation: asMember }, async (request) => ({
    projects: await listProjects(db, { orgId: request.params.orgId }),
  }));

  app.post<{ Params: OrgParams; Body: { name: string } }>(
    "/api/orgs/:orgId/projects",
    { preValidation: asMember, schema: { body: nameBodySchema } },
    async (request, reply) => {
      const name = requireName(request.body.name, "Project name");
      return reply.code(201).send(await createProject(db, request.params.orgId, name));
    }
  );

  app.delete<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId",
    { preValidation: asOwner },
    async (request, reply) => {
      const project = await requireProject(db, request.params);
      await deleteProject(db, project.id);
      return reply.code(204).send();
    }
  );

  app.get<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys",
    { preValidation: asMember },
    async (request) => {
      await requireProject(db, request.params);
      return { keys: await listApiKeys(db, request.params.projectId) };
    }
  );

  app.post<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys",
    { preValidation: asMember },
    async (request, reply) => {
      await requireProject(db, request.params);
      const created = await createApiKey(db, request.params.projectId);
      if (!created) {
        throw httpError(404, "Not Found");
      }
      return reply.code(201).send(created);
    }
  );

  app.post<{ Params: KeyParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys/:keyId/revoke",
    { preValidation: asMember },
    async (request) => {
      const { orgId, projectId, keyId } = request.params;
      const found = isUuid(projectId) && isUuid(keyId) ? await findApiKeyInOrg(db, orgId, projectId, keyId) : undefined;
      const result = found ? await revokeApiKey(db, keyId) : undefined;
      if (!result) {
        throw httpError(404, "Not Found");
      }
      return result;
    }
  );
}
