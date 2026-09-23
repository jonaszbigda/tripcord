import type { FastifyInstance } from "fastify";
import { requireMembership, requireUser } from "../auth/http";
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
type ProjectParams = OrgParams & { projectId: string };
type KeyParams = ProjectParams & { keyId: string };

// Key logic lives in db/projects.ts (shared with the CLI). These routes only add
// the tenant check: every project and key is looked up through :orgId first.
export function registerProjectRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;
  const asMember = [requireUser(db), requireMembership(db, "member")];

  async function requireProject({ orgId, projectId }: ProjectParams): Promise<void> {
    if (!isUuid(projectId) || !(await findProjectInOrg(db, orgId, projectId))) {
      throw httpError(404, "Not Found");
    }
  }

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

  app.get<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys",
    { preValidation: asMember },
    async (request) => {
      await requireProject(request.params);
      return { keys: await listApiKeys(db, request.params.projectId) };
    }
  );

  app.post<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/keys",
    { preValidation: asMember },
    async (request, reply) => {
      await requireProject(request.params);
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
