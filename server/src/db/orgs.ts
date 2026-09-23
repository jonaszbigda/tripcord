import { asc, eq, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { memberships, orgs, projects, type Org } from "./schema";

export interface OrgSummary extends Org {
  memberCount: number;
  projectCount: number;
}

export async function createOrg(ex: Executor, name: string): Promise<Org> {
  const [org] = await ex.insert(orgs).values({ name }).returning();
  return org;
}

export async function findOrg(ex: Executor, orgId: string): Promise<Org | undefined> {
  const [org] = await ex.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  return org;
}

export async function listOrgs(ex: Executor): Promise<OrgSummary[]> {
  return ex
    .select({
      id: orgs.id,
      name: orgs.name,
      createdAt: orgs.createdAt,
      // The org id is qualified explicitly (`"orgs"."id"`, not `${orgs.id}`):
      // drizzle's sql`` interpolation renders a column reference by its bare
      // name only, and "projects" (unlike "memberships") also has an "id"
      // column, so an unqualified reference would resolve to the wrong table.
      memberCount:
        sql<number>`(select count(*) from ${memberships} where ${memberships.orgId} = "orgs"."id")`.mapWith(Number),
      projectCount:
        sql<number>`(select count(*) from ${projects} where ${projects.orgId} = "orgs"."id")`.mapWith(Number),
    })
    .from(orgs)
    .orderBy(asc(orgs.createdAt));
}
