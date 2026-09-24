import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { addMember, createOrgWithOwner } from "../db/orgs";

const timeline = {
  sessionId: "s",
  reason: { type: "manual" },
  events: [],
  meta: { url: "https://example.com", userAgent: "ua", capturedAt: 1 },
};

async function fixture() {
  const db = getTestDb();
  const user = await createTestUser(db);
  const org = await createOrgWithOwner(db, user.id, "Acme");
  const member = await createTestUser(db);
  await addMember(db, org.id, member.id, "member");
  return {
    db,
    app: await buildTestApp(db),
    org,
    cookie: await sessionCookie(db, member.id),
    ownerCookie: await sessionCookie(db, user.id),
  };
}

function ingest(app: Awaited<ReturnType<typeof buildTestApp>>, key: string) {
  return app.inject({ method: "POST", url: "/v1/timeline", headers: { "x-tripcord-key": key }, payload: timeline });
}

describe("project routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("a member creates a project and gets a working key once", async () => {
    const { app, org, cookie } = await fixture();

    const response = await call(app, "POST", `/api/orgs/${org.id}/projects`, { cookie, body: { name: " web " } });

    expect(response.statusCode).toBe(201);
    const { project, key } = response.json();
    expect(project).toMatchObject({ orgId: org.id, name: "web" });
    expect(key).toMatch(/^tpk_/);
    expect((await ingest(app, key)).statusCode).toBe(201);
  });

  it("rejects a whitespace-only project name", async () => {
    const { app, org, cookie } = await fixture();
    const response = await call(app, "POST", `/api/orgs/${org.id}/projects`, { cookie, body: { name: "  " } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Project name is required" });
  });

  it("rejects a project name with control characters", async () => {
    const { app, org, cookie } = await fixture();
    const response = await call(app, "POST", `/api/orgs/${org.id}/projects`, { cookie, body: { name: "web\x1b[2J" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Project name must not contain control characters" });
  });

  it("lists only the org's projects", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project } = await createTestProject(db, "mine", org.id);
    await createTestProject(db, "someone else's");

    const response = await call(app, "GET", `/api/orgs/${org.id}/projects`, { cookie });

    expect(response.json().projects).toEqual([
      { id: project.id, orgId: org.id, name: "mine", createdAt: expect.any(String), activeKeyCount: 1 },
    ]);
  });

  it("lists keys without hashes, mints more, and revokes idempotently", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project, key: firstKey } = await createTestProject(db, "web", org.id);
    const base = `/api/orgs/${org.id}/projects/${project.id}/keys`;

    const minted = await call(app, "POST", base, { cookie });
    expect(minted.statusCode).toBe(201);
    expect(minted.json().key).toMatch(/^tpk_/);

    const listed = await call(app, "GET", base, { cookie });
    expect(listed.json().keys).toHaveLength(2);
    expect(listed.body).not.toContain("keyHash");
    expect(listed.body).not.toContain(firstKey);

    const firstId = listed.json().keys[0].id;
    const revoked = await call(app, "POST", `${base}/${firstId}/revoke`, { cookie });
    expect(revoked.json()).toMatchObject({ alreadyRevoked: false, apiKey: { id: firstId } });
    expect((await ingest(app, firstKey)).statusCode).toBe(401);

    const again = await call(app, "POST", `${base}/${firstId}/revoke`, { cookie });
    expect(again.json().alreadyRevoked).toBe(true);
  });

  it("won't revoke a key through a different project of the same org", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project: web } = await createTestProject(db, "web", org.id);
    const { project: api, key: apiKey } = await createTestProject(db, "api", org.id);
    const [apiKeyRow] = (await call(app, "GET", `/api/orgs/${org.id}/projects/${api.id}/keys`, { cookie })).json().keys;

    const response = await call(app, "POST", `/api/orgs/${org.id}/projects/${web.id}/keys/${apiKeyRow.id}/revoke`, {
      cookie,
    });

    expect(response.statusCode).toBe(404);
    expect((await ingest(app, apiKey)).statusCode).toBe(201);
  });

  it("returns 404 for unknown and malformed project and key ids", async () => {
    const { db, app, org, cookie } = await fixture();
    const { project } = await createTestProject(db, "web", org.id);
    const missing = "00000000-0000-0000-0000-000000000000";

    for (const url of [
      `/api/orgs/${org.id}/projects/${missing}/keys`,
      `/api/orgs/${org.id}/projects/nope/keys`,
    ]) {
      expect((await call(app, "GET", url, { cookie })).statusCode).toBe(404);
      expect((await call(app, "POST", url, { cookie })).statusCode).toBe(404);
    }
    for (const keyId of [missing, "nope"]) {
      const url = `/api/orgs/${org.id}/projects/${project.id}/keys/${keyId}/revoke`;
      expect((await call(app, "POST", url, { cookie })).statusCode).toBe(404);
    }
  });

  it("an owner deletes a project; its key stops working at ingest", async () => {
    const { app, db, org, ownerCookie } = await fixture();
    const { project, key } = await createTestProject(db, "doomed", org.id);

    const response = await call(app, "DELETE", `/api/orgs/${org.id}/projects/${project.id}`, { cookie: ownerCookie });

    expect(response.statusCode).toBe(204);
    const list = await call(app, "GET", `/api/orgs/${org.id}/projects`, { cookie: ownerCookie });
    expect(list.json().projects.map((p: { id: string }) => p.id)).not.toContain(project.id);
    expect((await ingest(app, key)).statusCode).toBe(401);
  });

  it("a member can't delete a project", async () => {
    const { app, db, org, cookie } = await fixture();
    const { project } = await createTestProject(db, "kept", org.id);
    const response = await call(app, "DELETE", `/api/orgs/${org.id}/projects/${project.id}`, { cookie });
    expect(response.statusCode).toBe(403);
  });
});
