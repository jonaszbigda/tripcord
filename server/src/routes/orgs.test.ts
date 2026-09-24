import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { TEST_ORIGIN, buildTestApp, call } from "../../test/http";
import { addMember, createOrgWithOwner, getMembership } from "../db/orgs";

async function fixture() {
  const db = getTestDb();
  const owner = await createTestUser(db, { name: "Olga", email: "olga@example.com" });
  const member = await createTestUser(db, { name: "Mark", email: "mark@example.com" });
  const org = await createOrgWithOwner(db, owner.id, "Acme");
  await addMember(db, org.id, member.id, "member");
  return {
    db,
    app: await buildTestApp(db),
    org,
    owner,
    member,
    ownerCookie: await sessionCookie(db, owner.id),
    memberCookie: await sessionCookie(db, member.id),
  };
}

describe("org routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("any logged-in user can create an org and becomes its owner", async () => {
    const { app, memberCookie } = await fixture();

    const response = await call(app, "POST", "/api/orgs", { cookie: memberCookie, body: { name: "  Beta  " } });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: expect.any(String), name: "Beta", role: "owner" });
    const me = await call(app, "GET", "/api/me", { cookie: memberCookie });
    expect(me.json().orgs.map((o: { name: string }) => o.name)).toContain("Beta");
  });

  it("rejects a whitespace-only org name", async () => {
    const { app, org, ownerCookie } = await fixture();

    const create = await call(app, "POST", "/api/orgs", { cookie: ownerCookie, body: { name: "   " } });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toEqual({ error: "Org name is required" });

    const rename = await call(app, "PATCH", `/api/orgs/${org.id}`, { cookie: ownerCookie, body: { name: " " } });
    expect(rename.statusCode).toBe(400);
  });

  it("rejects an org name with control characters", async () => {
    const { app, org, ownerCookie } = await fixture();

    const create = await call(app, "POST", "/api/orgs", { cookie: ownerCookie, body: { name: "Beta\nGamma" } });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toEqual({ error: "Org name must not contain control characters" });

    const rename = await call(app, "PATCH", `/api/orgs/${org.id}`, { cookie: ownerCookie, body: { name: "Beta\tGamma" } });
    expect(rename.statusCode).toBe(400);
  });

  it("owners rename the org; members get 403", async () => {
    const { app, org, ownerCookie, memberCookie } = await fixture();

    const renamed = await call(app, "PATCH", `/api/orgs/${org.id}`, { cookie: ownerCookie, body: { name: "Acme Inc" } });
    expect(renamed.json()).toEqual({ id: org.id, name: "Acme Inc" });

    const denied = await call(app, "PATCH", `/api/orgs/${org.id}`, { cookie: memberCookie, body: { name: "Nope" } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "Forbidden" });
  });

  it("members can list members", async () => {
    const { app, org, owner, member, memberCookie } = await fixture();

    const response = await call(app, "GET", `/api/orgs/${org.id}/members`, { cookie: memberCookie });

    expect(response.statusCode).toBe(200);
    expect(response.json().members).toEqual([
      { userId: owner.id, name: "Olga", email: "olga@example.com", role: "owner", joinedAt: expect.any(String) },
      { userId: member.id, name: "Mark", email: "mark@example.com", role: "member", joinedAt: expect.any(String) },
    ]);
  });

  it("owners change roles; the last owner can't be demoted; members get 403", async () => {
    const { app, db, org, owner, member, ownerCookie, memberCookie } = await fixture();

    const last = await call(app, "PATCH", `/api/orgs/${org.id}/members/${owner.id}`, {
      cookie: ownerCookie,
      body: { role: "member" },
    });
    expect(last.statusCode).toBe(409);
    expect(last.json()).toEqual({ error: "An org must have at least one owner" });

    const denied = await call(app, "PATCH", `/api/orgs/${org.id}/members/${member.id}`, {
      cookie: memberCookie,
      body: { role: "owner" },
    });
    expect(denied.statusCode).toBe(403);

    const promoted = await call(app, "PATCH", `/api/orgs/${org.id}/members/${member.id}`, {
      cookie: ownerCookie,
      body: { role: "owner" },
    });
    expect(promoted.json()).toEqual({ userId: member.id, role: "owner" });
    expect((await getMembership(db, org.id, member.id))?.role).toBe("owner");
  });

  it("rejects an unknown role with 400 and an unknown or malformed user with 404", async () => {
    const { app, db, org, ownerCookie } = await fixture();
    const stranger = await createTestUser(db);

    const badRole = await call(app, "PATCH", `/api/orgs/${org.id}/members/${stranger.id}`, {
      cookie: ownerCookie,
      body: { role: "admin" },
    });
    expect(badRole.statusCode).toBe(400);

    for (const userId of [stranger.id, "not-a-uuid"]) {
      const response = await call(app, "PATCH", `/api/orgs/${org.id}/members/${userId}`, {
        cookie: ownerCookie,
        body: { role: "owner" },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("a removed member loses access on their very next request", async () => {
    const { app, org, member, ownerCookie, memberCookie } = await fixture();
    expect((await call(app, "GET", `/api/orgs/${org.id}/members`, { cookie: memberCookie })).statusCode).toBe(200);

    const removed = await call(app, "DELETE", `/api/orgs/${org.id}/members/${member.id}`, { cookie: ownerCookie });
    expect(removed.statusCode).toBe(204);

    const after = await call(app, "GET", `/api/orgs/${org.id}/members`, { cookie: memberCookie });
    expect(after.statusCode).toBe(404);
  });

  it("members may leave but not remove others; the last owner can't leave", async () => {
    const { app, db, org, owner, member, ownerCookie, memberCookie } = await fixture();

    const removeOther = await call(app, "DELETE", `/api/orgs/${org.id}/members/${owner.id}`, { cookie: memberCookie });
    expect(removeOther.statusCode).toBe(403);

    const ownerLeaves = await call(app, "DELETE", `/api/orgs/${org.id}/members/${owner.id}`, { cookie: ownerCookie });
    expect(ownerLeaves.statusCode).toBe(409);

    const memberLeaves = await call(app, "DELETE", `/api/orgs/${org.id}/members/${member.id}`, { cookie: memberCookie });
    expect(memberLeaves.statusCode).toBe(204);
    expect(await getMembership(db, org.id, member.id)).toBeUndefined();
  });

  it("owners create, list and revoke invites; members get 403", async () => {
    const { app, org, ownerCookie, memberCookie } = await fixture();

    const created = await call(app, "POST", `/api/orgs/${org.id}/invites`, { cookie: ownerCookie, body: { role: "member" } });
    expect(created.statusCode).toBe(201);
    const { invite, link } = created.json();
    expect(link).toMatch(new RegExp(`^${TEST_ORIGIN}/invite/tpi_[A-Za-z0-9_-]{43}$`));
    expect(invite).toEqual({
      id: expect.any(String),
      role: "member",
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
      createdByName: "Olga",
    });

    const listed = await call(app, "GET", `/api/orgs/${org.id}/invites`, { cookie: ownerCookie });
    expect(listed.json().invites).toEqual([invite]);

    expect((await call(app, "POST", `/api/orgs/${org.id}/invites`, { cookie: memberCookie, body: { role: "member" } })).statusCode).toBe(403);
    expect((await call(app, "GET", `/api/orgs/${org.id}/invites`, { cookie: memberCookie })).statusCode).toBe(403);
    expect((await call(app, "DELETE", `/api/orgs/${org.id}/invites/${invite.id}`, { cookie: memberCookie })).statusCode).toBe(403);

    expect((await call(app, "DELETE", `/api/orgs/${org.id}/invites/${invite.id}`, { cookie: ownerCookie })).statusCode).toBe(204);
    expect((await call(app, "DELETE", `/api/orgs/${org.id}/invites/${invite.id}`, { cookie: ownerCookie })).statusCode).toBe(404);
    expect((await call(app, "GET", `/api/orgs/${org.id}/invites`, { cookie: ownerCookie })).json().invites).toEqual([]);
  });

  it("returns 401 without a session and 404 for a malformed org id", async () => {
    const { app, org, ownerCookie } = await fixture();
    expect((await call(app, "GET", `/api/orgs/${org.id}/members`)).statusCode).toBe(401);
    expect((await call(app, "GET", `/api/orgs/nope/members`, { cookie: ownerCookie })).statusCode).toBe(404);
  });

  it("an owner deletes the org; members lose it and keep their accounts", async () => {
    const { app, org, ownerCookie, memberCookie } = await fixture();

    expect((await call(app, "DELETE", `/api/orgs/${org.id}`, { cookie: ownerCookie })).statusCode).toBe(204);

    const me = await call(app, "GET", "/api/me", { cookie: memberCookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().orgs).toEqual([]);
  });

  it("a member can't delete the org", async () => {
    const { app, org, memberCookie } = await fixture();
    expect((await call(app, "DELETE", `/api/orgs/${org.id}`, { cookie: memberCookie })).statusCode).toBe(403);
  });
});
