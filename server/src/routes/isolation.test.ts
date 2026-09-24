import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, createTestUser, getTestDb, insertTestTimeline, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { createInvite, listPendingInvites } from "../db/invites";
import { addMember, createOrgWithOwner, getMembership } from "../db/orgs";
import { listApiKeys, listProjects } from "../db/projects";
import { orgs } from "../db/schema";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface Fixture {
  orgId: string;
  memberId: string;
  projectId: string;
  keyId: string;
  inviteId: string;
  timelineId: string;
}

interface RouteCase {
  /** Fastify's route pattern — must match the registered route exactly. */
  route: string;
  url: (f: Fixture) => string;
  body?: unknown;
}

// Every org-scoped route, in an order where the owner's positive-control run
// doesn't delete something a later case needs (the member is removed last).
const CASES: RouteCase[] = [
  { route: "PATCH /api/orgs/:orgId", url: (f) => `/api/orgs/${f.orgId}`, body: { name: "Hijacked" } },
  { route: "GET /api/orgs/:orgId/members", url: (f) => `/api/orgs/${f.orgId}/members` },
  {
    route: "PATCH /api/orgs/:orgId/members/:userId",
    url: (f) => `/api/orgs/${f.orgId}/members/${f.memberId}`,
    body: { role: "owner" },
  },
  { route: "GET /api/orgs/:orgId/invites", url: (f) => `/api/orgs/${f.orgId}/invites` },
  { route: "POST /api/orgs/:orgId/invites", url: (f) => `/api/orgs/${f.orgId}/invites`, body: { role: "owner" } },
  { route: "DELETE /api/orgs/:orgId/invites/:inviteId", url: (f) => `/api/orgs/${f.orgId}/invites/${f.inviteId}` },
  { route: "GET /api/orgs/:orgId/projects", url: (f) => `/api/orgs/${f.orgId}/projects` },
  { route: "POST /api/orgs/:orgId/projects", url: (f) => `/api/orgs/${f.orgId}/projects`, body: { name: "x" } },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/keys",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/keys`,
  },
  {
    route: "POST /api/orgs/:orgId/projects/:projectId/keys",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/keys`,
  },
  {
    route: "POST /api/orgs/:orgId/projects/:projectId/keys/:keyId/revoke",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/keys/${f.keyId}/revoke`,
  },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines`,
  },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines/summary",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines/summary`,
  },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines/tags",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines/tags`,
  },
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/timelines/:timelineId",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/timelines/${f.timelineId}`,
  },
  { route: "DELETE /api/orgs/:orgId/members/:userId", url: (f) => `/api/orgs/${f.orgId}/members/${f.memberId}` },
  {
    route: "DELETE /api/orgs/:orgId/projects/:projectId",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}`,
  },
  { route: "DELETE /api/orgs/:orgId", url: (f) => `/api/orgs/${f.orgId}` },
];

function methodOf(route: string): Method {
  return route.split(" ")[0] as Method;
}

async function setup() {
  const db = getTestDb();
  const owner = await createTestUser(db);
  const member = await createTestUser(db);
  const org = await createOrgWithOwner(db, owner.id, "Victim");
  await addMember(db, org.id, member.id, "member");
  const { project } = await createTestProject(db, "web", org.id);
  const [key] = await listApiKeys(db, project.id);
  const timelineId = await insertTestTimeline(db, project.id);
  const { invite } = await createInvite(db, { orgId: org.id, role: "member", createdBy: owner.id });

  const outsider = await createTestUser(db);
  const outsiderOrg = await createOrgWithOwner(db, outsider.id, "Attacker");

  const victim: Fixture = { orgId: org.id, memberId: member.id, projectId: project.id, keyId: key.id, inviteId: invite.id, timelineId };
  return {
    db,
    victim,
    ownerCookie: await sessionCookie(db, owner.id),
    outsiderCookie: await sessionCookie(db, outsider.id),
    outsiderOrgId: outsiderOrg.id,
  };
}

async function expectVictimUntouched(db: ReturnType<typeof getTestDb>, victim: Fixture) {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, victim.orgId));
  expect(org.name).toBe("Victim");
  expect((await getMembership(db, victim.orgId, victim.memberId))?.role).toBe("member");
  expect((await listApiKeys(db, victim.projectId))[0].revokedAt).toBeNull();
  expect(await listApiKeys(db, victim.projectId)).toHaveLength(1);
  expect(await listProjects(db, { orgId: victim.orgId })).toHaveLength(1);
  expect((await listPendingInvites(db, victim.orgId)).map((i) => i.id)).toEqual([victim.inviteId]);
}

describe("tenant isolation", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("covers every registered org-scoped route", async () => {
    const registered: string[] = [];
    await buildTestApp(getTestDb(), {
      onRoute: ({ method, url }) => {
        for (const m of [method].flat()) {
          if (m !== "HEAD" && url.startsWith("/api/orgs/:orgId")) {
            registered.push(`${m} ${url}`);
          }
        }
      },
    });

    expect(registered.sort()).toEqual(CASES.map((c) => c.route).sort());
  });

  it("a user from another org gets 404 on every org-scoped route and changes nothing", async () => {
    const { db, victim, outsiderCookie } = await setup();
    const app = await buildTestApp(db);

    for (const c of CASES) {
      const response = await call(app, methodOf(c.route), c.url(victim), { cookie: outsiderCookie, body: c.body });
      expect({ route: c.route, status: response.statusCode, body: response.json() }).toEqual({
        route: c.route,
        status: 404,
        body: { error: "Not Found" },
      });
    }
    await expectVictimUntouched(db, victim);
  });

  it("a user can't reach another org's resources through their own org id", async () => {
    const { db, victim, outsiderCookie, outsiderOrgId } = await setup();
    const app = await buildTestApp(db);
    const crossed: Fixture = { ...victim, orgId: outsiderOrgId };

    for (const c of CASES.filter((c) => c.route.split("/").length > 5)) {
      const response = await call(app, methodOf(c.route), c.url(crossed), { cookie: outsiderCookie, body: c.body });
      expect({ route: c.route, status: response.statusCode }).toEqual({ route: c.route, status: 404 });
    }
    await expectVictimUntouched(db, victim);
  });

  it("the org's owner can reach every route (so the 404s above mean something)", async () => {
    const { db, victim, ownerCookie } = await setup();
    const app = await buildTestApp(db);

    for (const c of CASES) {
      const response = await call(app, methodOf(c.route), c.url(victim), { cookie: ownerCookie, body: c.body });
      expect({ route: c.route, status: response.statusCode }).not.toEqual({ route: c.route, status: 404 });
    }
  });
});
