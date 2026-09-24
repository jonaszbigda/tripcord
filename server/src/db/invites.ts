import { and, asc, eq, gt, isNull, type SQL } from "drizzle-orm";
import type { Executor } from "./client";
import { invites, orgs, users, type Role } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteSummary {
  id: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
  /** NULL once the creator has deleted their account. */
  createdByName: string | null;
}

export interface CreatedInvite {
  invite: InviteSummary;
  /** Plaintext tpi_ token — shown once, never stored. */
  token: string;
}

export interface UsableInvite {
  id: string;
  /** NULL for a signup invite. */
  orgId: string | null;
  orgName: string | null;
  role: Role;
}

export interface CreatedSignupInvite {
  id: string;
  expiresAt: Date;
  /** Plaintext tpi_ token — shown once, never stored. */
  token: string;
}

// Not accepted, not revoked, not expired. Every read and write of an invite
// goes through this, so a used/revoked/expired invite behaves as if it didn't exist.
function usable(): SQL {
  return and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, new Date())) as SQL;
}

async function inviteSummaries(ex: Executor, where: SQL | undefined): Promise<InviteSummary[]> {
  return ex
    .select({
      id: invites.id,
      role: invites.role,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
      createdByName: users.name,
    })
    .from(invites)
    .leftJoin(users, eq(invites.createdBy, users.id))
    .where(where)
    .orderBy(asc(invites.createdAt));
}

export async function createInvite(
  ex: Executor,
  input: { orgId: string; role: Role; createdBy: string }
): Promise<CreatedInvite> {
  const { token, hash } = generateToken("tpi_");
  const [row] = await ex
    .insert(invites)
    .values({ ...input, tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
    .returning({ id: invites.id });
  const [invite] = await inviteSummaries(ex, eq(invites.id, row.id));
  return { invite, token };
}

/** A signup invite: whoever uses it gets a new account with its own org. Made by the admin CLI. */
export async function createSignupInvite(ex: Executor): Promise<CreatedSignupInvite> {
  const { token, hash } = generateToken("tpi_");
  const [row] = await ex
    .insert(invites)
    .values({ orgId: null, role: "owner", createdBy: null, tokenHash: hash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) })
    .returning({ id: invites.id, expiresAt: invites.expiresAt });
  return { ...row, token };
}

export async function listPendingSignupInvites(ex: Executor): Promise<{ id: string; createdAt: Date; expiresAt: Date }[]> {
  return ex
    .select({ id: invites.id, createdAt: invites.createdAt, expiresAt: invites.expiresAt })
    .from(invites)
    .where(and(isNull(invites.orgId), usable()))
    .orderBy(asc(invites.createdAt));
}

/** True if a pending signup invite was revoked; false if there was none. */
export async function revokeSignupInvite(ex: Executor, inviteId: string): Promise<boolean> {
  const revoked = await ex
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, inviteId), isNull(invites.orgId), usable()))
    .returning({ id: invites.id });
  return revoked.length > 0;
}

export async function listPendingInvites(ex: Executor, orgId: string): Promise<InviteSummary[]> {
  return inviteSummaries(ex, and(eq(invites.orgId, orgId), usable()));
}

/** True if a pending invite of this org was revoked; false if there was none. */
export async function revokeInvite(ex: Executor, orgId: string, inviteId: string): Promise<boolean> {
  const revoked = await ex
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.id, inviteId), eq(invites.orgId, orgId), usable()))
    .returning({ id: invites.id });
  return revoked.length > 0;
}

export async function findUsableInvite(ex: Executor, token: string): Promise<UsableInvite | undefined> {
  const [invite] = await ex
    .select({ id: invites.id, orgId: invites.orgId, orgName: orgs.name, role: invites.role })
    .from(invites)
    .leftJoin(orgs, eq(invites.orgId, orgs.id))
    .where(and(eq(invites.tokenHash, hashToken(token)), usable()))
    .limit(1);
  return invite;
}

// Conditional update: of two concurrent consumers, the second waits on the row
// lock, then re-checks `accepted_at IS NULL`, finds it set, and updates nothing.
export async function consumeInvite(ex: Executor, inviteId: string, userId: string): Promise<boolean> {
  const consumed = await ex
    .update(invites)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(and(eq(invites.id, inviteId), usable()))
    .returning({ id: invites.id });
  return consumed.length > 0;
}
