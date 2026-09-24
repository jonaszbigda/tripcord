import { describe, it, expect, beforeEach } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { createInvite } from "../db/invites";
import { createOrgWithOwner, getMembership } from "../db/orgs";

async function fixture() {
  const db = getTestDb();
  const owner = await createTestUser(db);
  const org = await createOrgWithOwner(db, owner.id, "Acme");
  const { token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: owner.id });
  return { db, app: await buildTestApp(db), org, owner, token };
}

describe("invite routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("previews a usable invite without logging in", async () => {
    const { app, token } = await fixture();
    const response = await call(app, "GET", `/api/invites/${token}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ orgName: "Acme", role: "member" });
  });

  it("returns 404 for an unknown invite", async () => {
    const { app } = await fixture();
    const response = await call(app, "GET", "/api/invites/tpi_nope");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Invite not found or expired" });
  });

  it("requires a session to accept", async () => {
    const { app, token } = await fixture();
    expect((await call(app, "POST", `/api/invites/${token}/accept`)).statusCode).toBe(401);
  });

  it("accepts once, then 404s for anyone else", async () => {
    const { app, db, org, token } = await fixture();
    const joiner = await createTestUser(db);
    const latecomer = await createTestUser(db);

    const accepted = await call(app, "POST", `/api/invites/${token}/accept`, { cookie: await sessionCookie(db, joiner.id) });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ orgId: org.id });
    expect((await getMembership(db, org.id, joiner.id))?.role).toBe("member");

    const late = await call(app, "POST", `/api/invites/${token}/accept`, { cookie: await sessionCookie(db, latecomer.id) });
    expect(late.statusCode).toBe(404);
  });

  it("returns 409 for an existing member", async () => {
    const { app, db, owner, token } = await fixture();
    const response = await call(app, "POST", `/api/invites/${token}/accept`, { cookie: await sessionCookie(db, owner.id) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Already a member" });
  });
});
