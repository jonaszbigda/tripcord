import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestOrg, createTestUser, getTestDb, resetDb } from "../../test/db";
import { hashToken } from "../auth/tokens";
import { invites } from "./schema";
import {
  INVITE_TTL_MS,
  consumeInvite,
  createInvite,
  findUsableInvite,
  listPendingInvites,
  revokeInvite,
} from "./invites";

async function setup() {
  const db = getTestDb();
  const org = await createTestOrg(db, "Acme");
  const creator = await createTestUser(db, { name: "Olga" });
  return { db, org, creator };
}

describe("invites", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates a 7-day tpi_ invite and stores only its hash", async () => {
    const { db, org, creator } = await setup();
    const before = Date.now();

    const { invite, token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });

    expect(token).toMatch(/^tpi_[A-Za-z0-9_-]{43}$/);
    expect(invite.role).toBe("member");
    expect(invite.createdByName).toBe("Olga");
    expect(invite.expiresAt.getTime()).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    const [row] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(row.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("finds a usable invite by token, with its org name", async () => {
    const { db, org, creator } = await setup();
    const { invite, token } = await createInvite(db, { orgId: org.id, role: "owner", createdBy: creator.id });

    expect(await findUsableInvite(db, token)).toEqual({ id: invite.id, orgId: org.id, orgName: "Acme", role: "owner" });
    expect(await findUsableInvite(db, "tpi_unknown")).toBeUndefined();
  });

  it("consumes an invite exactly once", async () => {
    const { db, org, creator } = await setup();
    const joiner = await createTestUser(db);
    const { invite, token } = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });

    expect(await consumeInvite(db, invite.id, joiner.id)).toBe(true);
    expect(await consumeInvite(db, invite.id, joiner.id)).toBe(false);
    expect(await findUsableInvite(db, token)).toBeUndefined();
  });

  it("treats expired and revoked invites as unusable", async () => {
    const { db, org, creator } = await setup();
    const expired = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    await db.update(invites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invites.id, expired.invite.id));
    const revoked = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    await revokeInvite(db, org.id, revoked.invite.id);

    expect(await findUsableInvite(db, expired.token)).toBeUndefined();
    expect(await findUsableInvite(db, revoked.token)).toBeUndefined();
    expect(await consumeInvite(db, expired.invite.id, creator.id)).toBe(false);
  });

  it("lists only pending invites, oldest first", async () => {
    const { db, org, creator } = await setup();
    const a = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    const b = await createInvite(db, { orgId: org.id, role: "owner", createdBy: creator.id });
    const c = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });
    await revokeInvite(db, org.id, c.invite.id);
    await consumeInvite(db, a.invite.id, creator.id);

    expect(await listPendingInvites(db, org.id)).toEqual([b.invite]);
  });

  it("revokes only a pending invite of the given org", async () => {
    const { db, org, creator } = await setup();
    const other = await createTestOrg(db, "Other");
    const { invite } = await createInvite(db, { orgId: org.id, role: "member", createdBy: creator.id });

    expect(await revokeInvite(db, other.id, invite.id)).toBe(false);
    expect(await revokeInvite(db, org.id, invite.id)).toBe(true);
    expect(await revokeInvite(db, org.id, invite.id)).toBe(false);
  });
});
