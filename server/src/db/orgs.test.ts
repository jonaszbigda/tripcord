import { describe, it, expect, beforeEach } from "vitest";
import { createTestOrg, createTestProject, createTestUser, createTestUserRow, getTestDb, resetDb } from "../../test/db";
import { memberships } from "./schema";
import {
  addMember,
  changeRole,
  createOrg,
  createOrgWithOwner,
  findOrg,
  getMembership,
  listMemberlessOrgIds,
  listMembers,
  listOrgs,
  listUserOrgs,
  removeMember,
  renameOrg,
} from "./orgs";

describe("orgs", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates and finds an org", async () => {
    const db = getTestDb();
    const org = await createOrg(db, "Acme");
    expect(org.name).toBe("Acme");
    expect((await findOrg(db, org.id))?.id).toBe(org.id);
    expect(await findOrg(db, "00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("lists orgs oldest first with member and project counts", async () => {
    const db = getTestDb();
    const acme = await createTestOrg(db, "Acme");
    const empty = await createTestOrg(db, "Empty");
    await createTestProject(db, "web", acme.id);
    await createTestProject(db, "api", acme.id);
    const user = await createTestUserRow(db);
    await db.insert(memberships).values({ orgId: acme.id, userId: user.id, role: "owner" });

    const result = await listOrgs(db);

    expect(result.map((o) => [o.id, o.name, o.memberCount, o.projectCount])).toEqual([
      [acme.id, "Acme", 1, 2],
      [empty.id, "Empty", 0, 0],
    ]);
  });
});

describe("memberships", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("createOrgWithOwner creates the org with the user as owner", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);

    const org = await createOrgWithOwner(db, user.id, "Acme");

    expect((await getMembership(db, org.id, user.id))?.role).toBe("owner");
  });

  it("lists a user's orgs in the order they joined", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const first = await createOrgWithOwner(db, user.id, "Zeta");
    const second = await createTestOrg(db, "Alpha");
    await addMember(db, second.id, user.id, "member");
    await createTestOrg(db, "Not mine");

    expect(await listUserOrgs(db, user.id)).toEqual([
      { id: first.id, name: "Zeta", role: "owner" },
      { id: second.id, name: "Alpha", role: "member" },
    ]);
  });

  it("lists an org's members with name, email, role and join time", async () => {
    const db = getTestDb();
    const owner = await createTestUser(db, { name: "Olga", email: "olga@example.com" });
    const member = await createTestUser(db, { name: "Mark", email: "mark@example.com" });
    const org = await createOrgWithOwner(db, owner.id, "Acme");
    await addMember(db, org.id, member.id, "member");

    const result = await listMembers(db, org.id);

    expect(result.map((m) => [m.userId, m.name, m.email, m.role])).toEqual([
      [owner.id, "Olga", "olga@example.com", "owner"],
      [member.id, "Mark", "mark@example.com", "member"],
    ]);
    expect(result[0].joinedAt).toBeInstanceOf(Date);
  });

  it("renames an org", async () => {
    const db = getTestDb();
    const org = await createTestOrg(db, "Old");
    expect((await renameOrg(db, org.id, "New"))?.name).toBe("New");
    expect(await renameOrg(db, "00000000-0000-0000-0000-000000000000", "X")).toBeUndefined();
  });

  it("lists orgs that have no members", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const orphan = await createTestOrg(db, "Default");
    await createOrgWithOwner(db, user.id, "Owned");

    expect(await listMemberlessOrgIds(db)).toEqual([orphan.id]);
  });
});

describe("changeRole / removeMember", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  async function orgWith(roles: ("owner" | "member")[]) {
    const db = getTestDb();
    const org = await createTestOrg(db);
    const members = [];
    for (const role of roles) {
      const user = await createTestUser(db);
      await addMember(db, org.id, user.id, role);
      members.push(user);
    }
    return { org, members };
  }

  it("promotes and demotes when another owner remains", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "member"]);

    expect(await changeRole(db, org.id, members[1].id, "owner")).toEqual({ ok: true });
    expect(await changeRole(db, org.id, members[0].id, "member")).toEqual({ ok: true });
    expect((await getMembership(db, org.id, members[0].id))?.role).toBe("member");
  });

  it("refuses to demote the last owner", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "member"]);

    expect(await changeRole(db, org.id, members[0].id, "member")).toEqual({ ok: false, reason: "last_owner" });
    expect((await getMembership(db, org.id, members[0].id))?.role).toBe("owner");
  });

  it("reports not_found for a non-member", async () => {
    const db = getTestDb();
    const { org } = await orgWith(["owner"]);
    const stranger = await createTestUser(db);

    expect(await changeRole(db, org.id, stranger.id, "owner")).toEqual({ ok: false, reason: "not_found" });
    expect(await removeMember(db, org.id, stranger.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("removes members but never the last owner", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "member"]);

    expect(await removeMember(db, org.id, members[1].id)).toEqual({ ok: true });
    expect(await getMembership(db, org.id, members[1].id)).toBeUndefined();
    expect(await removeMember(db, org.id, members[0].id)).toEqual({ ok: false, reason: "last_owner" });
  });

  it("two owners demoting each other at the same time leaves exactly one owner", async () => {
    const db = getTestDb();
    const { org, members } = await orgWith(["owner", "owner"]);

    const results = await Promise.all([
      changeRole(db, org.id, members[0].id, "member"),
      changeRole(db, org.id, members[1].id, "member"),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const roles = (await listMembers(db, org.id)).map((m) => m.role);
    expect(roles.filter((r) => r === "owner")).toHaveLength(1);
  });
});
