import { sql } from "drizzle-orm";
import type { Database } from "./db/client";
import type { User } from "./db/schema";
import { consumeInvite, findUsableInvite } from "./db/invites";
import { addMember, createOrgWithOwner, getMembership, listMemberlessOrgIds } from "./db/orgs";
import { countUsers, findUserByEmail, findUserByGithubId, insertUser } from "./db/users";

export const SIGNUP_MODES = ["open", "invite-only"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

// Arbitrary app-wide constant (next to MIGRATION_LOCK_ID in db/migrate.ts).
const SIGNUP_LOCK_ID = 727_402;

export interface SignUpInput {
  email: string;
  name: string;
  passwordHash: string | null;
  githubId: string | null;
  inviteToken?: string;
  mode: SignupMode;
  /** True when the address is already proven (GitHub) or doesn't need to be. Default false. */
  emailVerified?: boolean;
}

type SignUpFailure = "signup_closed" | "invite_invalid" | "email_taken" | "github_taken";

export type SignUpResult = { ok: true; user: User } | { ok: false; reason: SignUpFailure };

// Thrown inside the transaction to roll it back, then turned into a result.
class SignUpAborted extends Error {
  constructor(readonly reason: SignUpFailure) {
    super(reason);
  }
}

function personalOrgName(name: string): string {
  return `${name.slice(0, 94)}'s org`;
}

export async function signUp(db: Database, input: SignUpInput): Promise<SignUpResult> {
  try {
    const user = await db.transaction(async (tx) => {
      // Serializes signups, so two concurrent "first" signups can't both see an
      // empty users table and both bootstrap the instance.
      await tx.execute(sql`select pg_advisory_xact_lock(${SIGNUP_LOCK_ID})`);
      const bootstrap = (await countUsers(tx)) === 0;
      const invite = input.inviteToken === undefined ? undefined : await findUsableInvite(tx, input.inviteToken);
      if (input.inviteToken !== undefined && !invite) {
        throw new SignUpAborted("invite_invalid");
      }
      if (input.mode === "invite-only" && !bootstrap && !invite) {
        throw new SignUpAborted("signup_closed");
      }
      if (await findUserByEmail(tx, input.email)) {
        throw new SignUpAborted("email_taken");
      }
      if (input.githubId !== null && (await findUserByGithubId(tx, input.githubId))) {
        throw new SignUpAborted("github_taken");
      }

      const created = await insertUser(tx, {
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        githubId: input.githubId,
        emailVerifiedAt: input.emailVerified ? new Date() : null,
      });

      if (invite) {
        // An existing user (who doesn't take the signup lock) may have accepted
        // this invite since it was read above.
        if (!(await consumeInvite(tx, invite.id, created.id))) {
          throw new SignUpAborted("invite_invalid");
        }
        if (invite.orgId !== null) {
          await addMember(tx, invite.orgId, created.id, invite.role);
          return created;
        }
        // A signup invite: the new user gets their own org, as in open signup.
      }

      const orphaned = bootstrap ? await listMemberlessOrgIds(tx) : [];
      if (orphaned.length > 0) {
        for (const orgId of orphaned) {
          await addMember(tx, orgId, created.id, "owner");
        }
      } else {
        await createOrgWithOwner(tx, created.id, personalOrgName(created.name));
      }
      return created;
    });
    return { ok: true, user };
  } catch (error) {
    if (error instanceof SignUpAborted) {
      return { ok: false, reason: error.reason };
    }
    throw error;
  }
}

export type AcceptInviteResult =
  | { ok: true; orgId: string }
  | { ok: false; reason: "not_found" | "already_member" | "signup_only" };

export async function acceptInvite(db: Database, token: string, userId: string): Promise<AcceptInviteResult> {
  return db.transaction(async (tx) => {
    const invite = await findUsableInvite(tx, token);
    if (!invite) {
      return { ok: false, reason: "not_found" };
    }
    // Signup invites create accounts; they never add an existing user anywhere.
    if (invite.orgId === null) {
      return { ok: false, reason: "signup_only" };
    }
    const orgId = invite.orgId;
    // Checked before consuming, so an accidental click by a member doesn't burn the link.
    if (await getMembership(tx, orgId, userId)) {
      return { ok: false, reason: "already_member" };
    }
    if (!(await consumeInvite(tx, invite.id, userId))) {
      return { ok: false, reason: "not_found" };
    }
    await addMember(tx, orgId, userId, invite.role);
    return { ok: true, orgId };
  });
}
