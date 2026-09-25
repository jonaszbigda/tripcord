import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Database, Executor } from "./db/client";
import {
  apiKeys,
  emailVerifications,
  invites,
  memberships,
  orgs,
  passwordResets,
  projects,
  sessions,
  timelines,
  users,
} from "./db/schema";

// Hard deletes, children first, each in one transaction. The foreign keys have
// no ON DELETE actions on purpose: a dependency added later and forgotten here
// fails loudly instead of silently taking rows with it.

export interface OrgRef {
  id: string;
  name: string;
}

export async function deleteProject(ex: Executor, projectId: string): Promise<void> {
  await ex.transaction(async (tx) => {
    await tx.delete(timelines).where(eq(timelines.projectId, projectId));
    await tx.delete(apiKeys).where(eq(apiKeys.projectId, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
  });
}

export async function deleteOrg(ex: Executor, orgId: string): Promise<void> {
  await ex.transaction(async (tx) => {
    // Locking the org row makes concurrent inserts that reference it (a new
    // project, an invite being accepted) wait, then fail, instead of racing.
    await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).for("update");
    const orgProjects = await tx.select({ id: projects.id }).from(projects).where(eq(projects.orgId, orgId));
    for (const project of orgProjects) {
      await deleteProject(tx, project.id);
    }
    await tx.delete(invites).where(eq(invites.orgId, orgId));
    await tx.delete(memberships).where(eq(memberships.orgId, orgId));
    await tx.delete(orgs).where(eq(orgs.id, orgId));
  });
}

export async function orgDeletionSummary(
  ex: Executor,
  orgId: string
): Promise<{ memberCount: number; projectCount: number; timelineCount: number }> {
  const [members] = await ex.select({ n: count() }).from(memberships).where(eq(memberships.orgId, orgId));
  const orgProjects = await ex.select({ id: projects.id }).from(projects).where(eq(projects.orgId, orgId));
  const ids = orgProjects.map((p) => p.id);
  const [rows] =
    ids.length === 0 ? [{ n: 0 }] : await ex.select({ n: count() }).from(timelines).where(inArray(timelines.projectId, ids));
  return { memberCount: members.n, projectCount: ids.length, timelineCount: rows.n };
}

export interface UserDeletionPlan {
  /** Orgs where the user is the only member: deleted with them. */
  soleMemberOrgs: OrgRef[];
  /** Orgs where the user is the only owner but not the only member: deletion is refused. */
  blockingOrgs: OrgRef[];
}

// With `lock`, each owned org's row is locked first, so nobody joins or is
// promoted between this check and the deletes that follow it.
async function classifyOwnedOrgs(ex: Executor, userId: string, lock: boolean): Promise<UserDeletionPlan> {
  const owned = await ex
    .select({ id: orgs.id, name: orgs.name })
    .from(memberships)
    .innerJoin(orgs, eq(memberships.orgId, orgs.id))
    .where(and(eq(memberships.userId, userId), eq(memberships.role, "owner")))
    .orderBy(asc(orgs.name));
  const plan: UserDeletionPlan = { soleMemberOrgs: [], blockingOrgs: [] };
  for (const org of owned) {
    if (lock) {
      await ex.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, org.id)).for("update");
    }
    const members = await ex.select().from(memberships).where(eq(memberships.orgId, org.id));
    if (members.length === 1) {
      plan.soleMemberOrgs.push(org);
    } else if (!members.some((m) => m.userId !== userId && m.role === "owner")) {
      plan.blockingOrgs.push(org);
    }
  }
  return plan;
}

export async function planUserDeletion(ex: Executor, userId: string): Promise<UserDeletionPlan> {
  return classifyOwnedOrgs(ex, userId, false);
}

export type DeleteUserResult =
  | { ok: true; deletedOrgs: OrgRef[] }
  | { ok: false; reason: "sole_owner"; orgs: OrgRef[] };

export async function deleteUser(db: Database, userId: string): Promise<DeleteUserResult> {
  return db.transaction(async (tx) => {
    const plan = await classifyOwnedOrgs(tx, userId, true);
    if (plan.blockingOrgs.length > 0) {
      return { ok: false, reason: "sole_owner", orgs: plan.blockingOrgs };
    }
    for (const org of plan.soleMemberOrgs) {
      await deleteOrg(tx, org.id);
    }
    await tx.delete(memberships).where(eq(memberships.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
    await tx.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
    // Invites in orgs that live on keep their history, without a name.
    await tx.update(invites).set({ createdBy: null }).where(eq(invites.createdBy, userId));
    await tx.update(invites).set({ acceptedBy: null }).where(eq(invites.acceptedBy, userId));
    await tx.delete(users).where(eq(users.id, userId));
    return { ok: true, deletedOrgs: plan.soleMemberOrgs };
  });
}
