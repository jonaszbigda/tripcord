import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestOrg, createTestUser, getTestDb, resetDb } from "../test/db";
import { invites } from "./db/schema";
import {
  createInvite,
  createSignupInvite,
  findUsableInvite,
  listPendingInvites,
  listPendingSignupInvites,
  revokeSignupInvite,
} from "./db/invites";
import { addMember, getMembership, listUserOrgs } from "./db/orgs";
import { acceptInvite, signUp, type SignUpInput } from "./accounts";

function input(overrides: Partial<SignUpInput> = {}): SignUpInput {
  return {
    email: "ana@example.com",
    name: "Ana",
    passwordHash: "scrypt$fake",
    githubId: null,
    mode: "open",
    ...overrides,
  };
}

async function inviteTo(orgName = "Acme", role: "owner" | "member" = "member") {
  const db = getTestDb();
  const org = await createTestOrg(db, orgName);
  const owner = await createTestUser(db);
  await addMember(db, org.id, owner.id, "owner");
  const { invite, token } = await createInvite(db, { orgId: org.id, role, createdBy: owner.id });
  return { org, owner, invite, token };
}

describe("signUp", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("open signup creates the user with a personal org they own", async () => {
    await createTestUser(getTestDb()); // not the first user
    const result = await signUp(getTestDb(), input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.email).toBe("ana@example.com");
    const orgs = await listUserOrgs(getTestDb(), result.user.id);
    expect(orgs).toEqual([{ id: expect.any(String), name: "Ana's org", role: "owner" }]);
  });

  it("invite-only signup is closed once the instance has users", async () => {
    await createTestUser(getTestDb());
    expect(await signUp(getTestDb(), input({ mode: "invite-only" }))).toEqual({ ok: false, reason: "signup_closed" });
  });

  it("the first user bootstraps an invite-only instance with a personal org", async () => {
    const result = await signUp(getTestDb(), input({ mode: "invite-only" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await listUserOrgs(getTestDb(), result.user.id)).map((o) => o.name)).toEqual(["Ana's org"]);
  });

  it("the first user takes over memberless orgs instead of getting a personal org", async () => {
    const legacy = await createTestOrg(getTestDb(), "Default");

    const result = await signUp(getTestDb(), input({ mode: "invite-only" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await listUserOrgs(getTestDb(), result.user.id)).toEqual([
      { id: legacy.id, name: "Default", role: "owner" },
    ]);
  });

  it("an invite signup joins the invite's org with its role, consumes the invite, and gets no personal org", async () => {
    const { org, token } = await inviteTo("Acme", "member");

    const result = await signUp(getTestDb(), input({ mode: "invite-only", inviteToken: token }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await listUserOrgs(getTestDb(), result.user.id)).toEqual([{ id: org.id, name: "Acme", role: "member" }]);
    expect(await findUsableInvite(getTestDb(), token)).toBeUndefined();
  });

  it("an unusable invite token fails even when signup is open", async () => {
    await createTestUser(getTestDb());
    expect(await signUp(getTestDb(), input({ inviteToken: "tpi_nope" }))).toEqual({
      ok: false,
      reason: "invite_invalid",
    });
  });

  it("rejects a taken email regardless of case, leaving the invite unused", async () => {
    const { token } = await inviteTo();
    await createTestUser(getTestDb(), { email: "ana@example.com" });

    expect(await signUp(getTestDb(), input({ email: "ANA@example.com", inviteToken: token }))).toEqual({
      ok: false,
      reason: "email_taken",
    });
    expect(await findUsableInvite(getTestDb(), token)).toBeDefined();
  });

  it("rejects a GitHub id that is already linked", async () => {
    await createTestUser(getTestDb(), { githubId: "42" });
    expect(await signUp(getTestDb(), input({ githubId: "42", passwordHash: null }))).toEqual({
      ok: false,
      reason: "github_taken",
    });
  });

  it("a signup invite opens an invite-only instance to a new user with their own org", async () => {
    await createTestUser(getTestDb()); // not the first user
    const { token } = await createSignupInvite(getTestDb());

    const result = await signUp(getTestDb(), input({ mode: "invite-only", inviteToken: token }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await listUserOrgs(getTestDb(), result.user.id)).toEqual([
      { id: expect.any(String), name: "Ana's org", role: "owner" },
    ]);
    expect(await findUsableInvite(getTestDb(), token)).toBeUndefined();
  });

  it("two concurrent first signups on an invite-only instance bootstrap exactly once", async () => {
    const results = await Promise.all([
      signUp(getTestDb(), input({ mode: "invite-only", email: "a@example.com" })),
      signUp(getTestDb(), input({ mode: "invite-only", email: "b@example.com" })),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "signup_closed" }]);
  });
});

describe("acceptInvite", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("adds the user to the org with the invite's role", async () => {
    const { org, token } = await inviteTo("Acme", "owner");
    const user = await createTestUser(getTestDb());

    expect(await acceptInvite(getTestDb(), token, user.id)).toEqual({ ok: true, orgId: org.id });
    expect((await getMembership(getTestDb(), org.id, user.id))?.role).toBe("owner");
  });

  it("refuses a signup invite for an existing user and leaves it usable", async () => {
    const user = await createTestUser(getTestDb());
    const { token } = await createSignupInvite(getTestDb());

    expect(await acceptInvite(getTestDb(), token, user.id)).toEqual({ ok: false, reason: "signup_only" });
    expect(await findUsableInvite(getTestDb(), token)).toBeDefined();
  });

  it("refuses an existing member and leaves the invite usable", async () => {
    const { owner, token } = await inviteTo();

    expect(await acceptInvite(getTestDb(), token, owner.id)).toEqual({ ok: false, reason: "already_member" });
    expect(await findUsableInvite(getTestDb(), token)).toBeDefined();
  });

  it("is single-use", async () => {
    const { token } = await inviteTo();
    const first = await createTestUser(getTestDb());
    const second = await createTestUser(getTestDb());

    await acceptInvite(getTestDb(), token, first.id);

    expect(await acceptInvite(getTestDb(), token, second.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses an expired invite", async () => {
    const { invite, token } = await inviteTo();
    await getTestDb()
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.id, invite.id));
    const user = await createTestUser(getTestDb());

    expect(await acceptInvite(getTestDb(), token, user.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("lets only one of two concurrent acceptances through", async () => {
    const { token } = await inviteTo();
    const a = await createTestUser(getTestDb());
    const b = await createTestUser(getTestDb());

    const results = await Promise.all([
      acceptInvite(getTestDb(), token, a.id),
      acceptInvite(getTestDb(), token, b.id),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});

describe("signup invites", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("are listed and revoked apart from org invites", async () => {
    const { org } = await inviteTo();
    const { id } = await createSignupInvite(getTestDb());

    expect((await listPendingSignupInvites(getTestDb())).map((i) => i.id)).toEqual([id]);
    expect((await listPendingInvites(getTestDb(), org.id)).map((i) => i.id)).not.toContain(id);

    expect(await revokeSignupInvite(getTestDb(), id)).toBe(true);
    expect(await revokeSignupInvite(getTestDb(), id)).toBe(false);
    expect(await listPendingSignupInvites(getTestDb())).toEqual([]);
  });

  it("revokeSignupInvite ignores org invites", async () => {
    const { invite } = await inviteTo();
    expect(await revokeSignupInvite(getTestDb(), invite.id)).toBe(false);
  });
});
