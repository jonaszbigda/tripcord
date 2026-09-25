import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, createTestUser, getTestDb, insertTestTimeline, resetDb } from "../test/db";
import { createInvite, listPendingInvites } from "./db/invites";
import { addMember, createOrgWithOwner, findOrg, listUserOrgs } from "./db/orgs";
import { createPasswordReset } from "./db/password-resets";
import { findProjectByApiKey, listProjects } from "./db/projects";
import { apiKeys, emailVerifications, passwordResets, sessions, timelines } from "./db/schema";
import { createSession } from "./db/sessions";
import { findUserById } from "./db/users";
import { deleteOrg, deleteProject, deleteUser, orgDeletionSummary, planUserDeletion } from "./deletion";

describe("deleteProject", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes the project with its keys and timelines, and nothing else", async () => {
    const db = getTestDb();
    const doomed = await createTestProject(db, "doomed");
    const kept = await createTestProject(db, "kept", doomed.project.orgId);
    await insertTestTimeline(db, doomed.project.id);
    const keptTimeline = await insertTestTimeline(db, kept.project.id);

    await deleteProject(db, doomed.project.id);

    expect((await listProjects(db)).map((p) => p.name)).toEqual(["kept"]);
    expect(await findProjectByApiKey(db, doomed.key)).toBeUndefined();
    expect(await db.select().from(apiKeys).where(eq(apiKeys.projectId, doomed.project.id))).toEqual([]);
    expect((await db.select({ id: timelines.id }).from(timelines)).map((t) => t.id)).toEqual([keptTimeline]);
  });
});

describe("deleteOrg", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes projects, invites and memberships; members keep their accounts; other orgs are untouched", async () => {
    const db = getTestDb();
    const owner = await createTestUser(db);
    const member = await createTestUser(db);
    const org = await createOrgWithOwner(db, owner.id, "Doomed");
    await addMember(db, org.id, member.id, "member");
    const { project } = await createTestProject(db, "web", org.id);
    await insertTestTimeline(db, project.id);
    await createInvite(db, { orgId: org.id, role: "member", createdBy: owner.id });
    const other = await createOrgWithOwner(db, member.id, "Kept");
    await createTestProject(db, "kept", other.id);

    await deleteOrg(db, org.id);

    expect(await findOrg(db, org.id)).toBeUndefined();
    expect((await listProjects(db)).map((p) => p.name)).toEqual(["kept"]);
    expect(await listUserOrgs(db, owner.id)).toEqual([]);
    expect((await listUserOrgs(db, member.id)).map((o) => o.name)).toEqual(["Kept"]);
    expect(await findUserById(db, owner.id)).toBeDefined();
  });

  it("summarizes what it will delete", async () => {
    const db = getTestDb();
    const owner = await createTestUser(db);
    const org = await createOrgWithOwner(db, owner.id, "Acme");
    const { project } = await createTestProject(db, "web", org.id);
    await insertTestTimeline(db, project.id);
    await insertTestTimeline(db, project.id);

    expect(await orgDeletionSummary(db, org.id)).toEqual({ memberCount: 1, projectCount: 1, timelineCount: 2 });
  });
});

describe("deleteUser", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes the user with the orgs only they belong to, and leaves shared orgs", async () => {
    const db = getTestDb();
    const ana = await createTestUser(db, { name: "Ana" });
    const bob = await createTestUser(db, { name: "Bob" });
    const solo = await createOrgWithOwner(db, ana.id, "Solo");
    await createTestProject(db, "solo-web", solo.id);
    const coOwned = await createOrgWithOwner(db, ana.id, "CoOwned");
    await addMember(db, coOwned.id, bob.id, "owner");
    const joined = await createOrgWithOwner(db, bob.id, "Joined");
    await addMember(db, joined.id, ana.id, "member");
    await createSession(db, ana.id);
    await createPasswordReset(db, ana.id, ana.email);

    expect(await deleteUser(db, ana.id)).toEqual({ ok: true, deletedOrgs: [{ id: solo.id, name: "Solo" }] });

    expect(await findUserById(db, ana.id)).toBeUndefined();
    expect(await findOrg(db, solo.id)).toBeUndefined();
    expect((await listUserOrgs(db, bob.id)).map((o) => o.name).sort()).toEqual(["CoOwned", "Joined"]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, ana.id))).toEqual([]);
    expect(await db.select().from(passwordResets).where(eq(passwordResets.userId, ana.id))).toEqual([]);
  });

  it("refuses when the user is the only owner of an org with other members, and deletes nothing", async () => {
    const db = getTestDb();
    const ana = await createTestUser(db);
    const bob = await createTestUser(db);
    const team = await createOrgWithOwner(db, ana.id, "Team");
    await addMember(db, team.id, bob.id, "member");
    const solo = await createOrgWithOwner(db, ana.id, "Solo");

    expect(await planUserDeletion(db, ana.id)).toEqual({
      soleMemberOrgs: [{ id: solo.id, name: "Solo" }],
      blockingOrgs: [{ id: team.id, name: "Team" }],
    });
    expect(await deleteUser(db, ana.id)).toEqual({ ok: false, reason: "sole_owner", orgs: [{ id: team.id, name: "Team" }] });
    expect(await findUserById(db, ana.id)).toBeDefined();
    expect(await findOrg(db, solo.id)).toBeDefined();
  });

  it("keeps the pending invites a deleted user created, with no creator name", async () => {
    const db = getTestDb();
    const ana = await createTestUser(db);
    const bob = await createTestUser(db);
    const org = await createOrgWithOwner(db, bob.id, "Acme");
    await addMember(db, org.id, ana.id, "owner");
    const { invite } = await createInvite(db, { orgId: org.id, role: "member", createdBy: ana.id });

    expect((await deleteUser(db, ana.id)).ok).toBe(true);

    expect(await listPendingInvites(db, org.id)).toEqual([{ ...invite, createdByName: null }]);
  });

  it("removes the user's email verification links", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { emailVerified: false });
    const now = new Date();
    await db.insert(emailVerifications).values({
      tokenHash: "hash",
      userId: user.id,
      email: user.email,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    expect((await deleteUser(db, user.id)).ok).toBe(true);

    expect(await db.select().from(emailVerifications).where(eq(emailVerifications.userId, user.id))).toEqual([]);
  });
});
