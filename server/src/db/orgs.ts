import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Executor } from "./client";
import { memberships, orgs, projects, users, type Membership, type Org, type Role } from "./schema";

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

export interface UserOrg {
  id: string;
  name: string;
  role: Role;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: Date;
}

export type MembershipChange = { ok: true } | { ok: false; reason: "not_found" | "last_owner" };

export async function addMember(ex: Executor, orgId: string, userId: string, role: Role): Promise<Membership> {
  const [membership] = await ex.insert(memberships).values({ orgId, userId, role }).returning();
  return membership;
}

export async function createOrgWithOwner(ex: Executor, userId: string, name: string): Promise<Org> {
  // Nested inside a caller's transaction, this becomes a savepoint.
  return ex.transaction(async (tx) => {
    const org = await createOrg(tx, name);
    await addMember(tx, org.id, userId, "owner");
    return org;
  });
}

export async function getMembership(ex: Executor, orgId: string, userId: string): Promise<Membership | undefined> {
  const [membership] = await ex
    .select()
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
    .limit(1);
  return membership;
}

export async function listUserOrgs(ex: Executor, userId: string): Promise<UserOrg[]> {
  return ex
    .select({ id: orgs.id, name: orgs.name, role: memberships.role })
    .from(memberships)
    .innerJoin(orgs, eq(memberships.orgId, orgs.id))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.createdAt), asc(orgs.name));
}

export async function listMembers(ex: Executor, orgId: string): Promise<Member[]> {
  return ex
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.orgId, orgId))
    .orderBy(asc(memberships.createdAt));
}

export async function renameOrg(ex: Executor, orgId: string, name: string): Promise<Org | undefined> {
  const [org] = await ex.update(orgs).set({ name }).where(eq(orgs.id, orgId)).returning();
  return org;
}

// Orgs nobody can reach — in practice the "Default" org the 0002 migration creates
// for projects that predate orgs. The first user to sign up takes them over.
export async function listMemberlessOrgIds(ex: Executor): Promise<string[]> {
  const rows = await ex
    .select({ id: orgs.id })
    .from(orgs)
    .leftJoin(memberships, eq(memberships.orgId, orgs.id))
    .where(isNull(memberships.userId));
  return rows.map((row) => row.id);
}

// Locks every membership row of the org for the rest of the transaction, so two
// concurrent demotions/removals can't each see "another owner remains" and
// together leave the org without an owner.
async function withLockedMembers(
  ex: Executor,
  orgId: string,
  fn: (tx: Executor, members: Membership[]) => Promise<MembershipChange>
): Promise<MembershipChange> {
  return ex.transaction(async (tx) => {
    const members = await tx.select().from(memberships).where(eq(memberships.orgId, orgId)).for("update");
    return fn(tx, members);
  });
}

function isLastOwner(members: Membership[], target: Membership): boolean {
  return target.role === "owner" && members.filter((m) => m.role === "owner").length === 1;
}

export async function changeRole(ex: Executor, orgId: string, userId: string, role: Role): Promise<MembershipChange> {
  return withLockedMembers(ex, orgId, async (tx, members) => {
    const target = members.find((m) => m.userId === userId);
    if (!target) {
      return { ok: false, reason: "not_found" };
    }
    if (role !== "owner" && isLastOwner(members, target)) {
      return { ok: false, reason: "last_owner" };
    }
    await tx
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    return { ok: true };
  });
}

export async function removeMember(ex: Executor, orgId: string, userId: string): Promise<MembershipChange> {
  return withLockedMembers(ex, orgId, async (tx, members) => {
    const target = members.find((m) => m.userId === userId);
    if (!target) {
      return { ok: false, reason: "not_found" };
    }
    if (isLastOwner(members, target)) {
      return { ok: false, reason: "last_owner" };
    }
    await tx.delete(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    return { ok: true };
  });
}
