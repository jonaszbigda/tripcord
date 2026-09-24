# Tripcord Hosted Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the hosted beta at `app.tripcord.dev` needs that ships in code:
- signup invites for new accounts
- optional SMTP email with password reset
- deleting projects, orgs and accounts
- NDJSON export
- logs without IPs or tokens
- admin CLI commands for all of the above
- a landing site at `tripcord.dev` with the commitments and privacy pages
- an off-site backup script
- server `0.2.0`

**Architecture:**
- **Server services.** New work lands in small service modules next to the existing ones. Every one takes an `Executor`, as today:
  - `db/password-resets.ts`, `password-reset.ts`: tokens and the reset flow.
  - `deletion.ts`: hard deletes in dependency order.
  - `email.ts`: the `Mailer` interface, the nodemailer transport and the two messages.
- **Routes.** They stay thin and reuse the existing guards (`requireUser`, `requireMembership`, `requireProject`).
- **Email is optional.** Without SMTP, the password-reset routes aren't registered, and `/api/auth/config` says so.
- **Dashboard.** Two public pages (forgot / reset password), a signup-invite variant of the invite page, a project **Settings** tab, and a delete section on each of the three settings pages.
- **Site.** A new `site/` workspace: static multi-page Vite + Tailwind, sharing the dashboard's `theme.css`, deployed to GitHub Pages.
- **Backups.** `deploy/backup.sh` runs `pg_dump` then `restic` to any restic repository (Backblaze B2 through its S3 API for the hosted instance).

**Tech Stack:** TypeScript, Fastify 5, Drizzle ORM 0.36 + drizzle-kit 0.28, `pg`, `nodemailer` (new), Vitest 2 + testcontainers, React 18, React Router 7, TanStack Query 5, Tailwind CSS 4, Vite 5, GitHub Actions + GitHub Pages, restic, bash.

**Spec:** `docs/superpowers/specs/2026-09-24-tripcord-hosted-beta-design.md`

## Global Constraints

- **Hard deletes, explicit order, no `ON DELETE`.** Every delete runs in one transaction, children first. The foreign keys keep their default `NO ACTION`, so a dependency someone forgets fails loudly. API keys keep their soft revoke. Deleting a project deletes its keys outright.
- **Owner-only deletes.** Deleting a project or an org needs the `owner` role. Non-members get `404`, members `403`, exactly like the other owner routes. Export is open to any member.
- **Signup invites** are `invites` rows with `org_id` NULL, `role` `owner`, `created_by` NULL. They're created only by the admin CLI, never from the dashboard. The token prefix and TTL are the same as org invites (`tpi_`, 7 days).
- **`GET /api/invites/:token` keeps its shape.** It returns `{ orgName, role }`, and `orgName` is `null` for a signup invite. This clarifies the spec's `org: null`.
- **Password reset tokens** are `tpr_` + base64url(32 bytes). They're valid for 1 hour and single-use, and only the SHA-256 is stored. A new request deletes the user's unused tokens. At most one request per user per 2 minutes (`cooldown`).
- **The reset request never reveals whether an account exists.** It always returns `204`, and the lookup and the send run after the reply.
- **Email:** `SMTP_URL` and `EMAIL_FROM` must be set together, or startup fails. Plain-text messages only.
- **Logs:** no client IPs and no `tpi_` / `tpr_` / `tpk_` tokens in any log line. IPs are used only in memory, by the rate limiters. The privacy page states this. The spec says the same.
- **Rate limits:** the password-reset endpoints and `DELETE /api/me` use the same per-IP limit as login (`authRateLimitMax` per minute).
- **Error envelope:** `{ error }` everywhere. The one addition is `409 { error, orgs: [{ id, name }] }` from `DELETE /api/me`.
- **CSRF:** unchanged. The dashboard always sends a JSON body with `DELETE /api/me` (`{}` for GitHub-only users), because the route has a body schema.
- **No new dashboard dependency.** The site adds no runtime JavaScript dependency. The server adds `nodemailer` (pure JS, no install scripts, so the image's `build` stage still runs on the build platform) and `@types/nodemailer`.
- **Workspaces:** `site` joins the root `workspaces`. Both npm stages of `server/Dockerfile` must copy `site/package.json`, or `npm ci` fails.
- **Test conventions:** as today. Vitest, one shared testcontainers Postgres, `resetDb` in `beforeEach`, `buildTestApp` + `call` for routes, `mockApi` + `renderApp` in the dashboard.
- **Commits:** one per task, conventional style (`feat(server): …`, `feat(dashboard): …`, `feat(site): …`, `docs: …`), with no AI attribution lines.

## Review Focus

These are the cases most likely to be wrong while the happy paths pass. Each one has a pinned test in the task named.

1. **An org invite still can't create a personal org, and a signup invite can't join anyone.** Signing up with an org invite gives no personal org. Accepting a signup invite while logged in is `409`, and it doesn't consume the invite. (Task 1)
2. **Pending invites of a deleted creator stay visible.** `listPendingInvites` must `leftJoin` users, or the invite silently vanishes from the Members page. (Tasks 1, 4)
3. **Reset tokens can't be replayed or stretched.** A used token is `400`, an expired one is `400`, and a second request (after the cooldown) kills the first link. Confirming logs the user out everywhere. (Task 3)
4. **Account deletion never orphans an org.** Being the only owner of an org with other members is `409`, and nothing is deleted. An org where the user is the only member is deleted with them. Co-owned orgs survive. (Tasks 4, 5)
5. **Tokens never reach the logs.** `GET /api/invites/tpi_…` and the SPA route `/reset-password/tpr_…` log `tpi_[redacted]` / `tpr_[redacted]`, with no `remoteAddress`. (Task 7)
6. **Export pages correctly.** With a batch size smaller than the row count, every timeline appears exactly once, oldest first. That includes rows sharing a `received_at`. (Task 6)

## Prerequisites

From the repo root, once: `npm install`. Docker must be running for the server tests.

Commands:
- Server: `npm test -w server`, or one file with `npm test -w server -- src/deletion.test.ts`.
- Dashboard: `npm test -w dashboard`.
- Site: `npm test -w site`.
- Whole repo: `npm run build && npm run typecheck && npm run lint && npm test`.

Before Task 11: ask the author which **Backblaze region** the B2 account is in (EU Central, or a US region). The privacy page names it. The contact address is `hello@tripcord.dev`.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `server/src/db/schema.ts` | modify | `invites.orgId` / `createdBy` nullable; `passwordResets` table |
| `server/drizzle/0004_hosted_beta.sql` + `meta/*` | generate | migration |
| `server/src/db/invites.ts` | modify | left joins; `createSignupInvite`, `listPendingSignupInvites`, `revokeSignupInvite` |
| `server/src/accounts.ts` | modify | signup-invite path in `signUp`; `signup_only` in `acceptInvite` |
| `server/src/routes/invites.ts` | modify | `orgName: null` preview; `409` for signup invites |
| `server/src/email.ts` | create | `Mailer`, `createSmtpMailer`, `passwordResetMail`, `signupInviteMail` |
| `server/src/config.ts` | modify | `email?: EmailConfig` from `SMTP_URL` / `EMAIL_FROM` |
| `server/src/db/password-resets.ts` | create | token rows: create, latest, consume, cleanup |
| `server/src/password-reset.ts` | create | `requestPasswordReset`, `resetPassword` |
| `server/src/routes/password-reset.ts` | create | the two `/api/auth/password-reset` routes |
| `server/src/routes/auth.ts` | modify | `passwordReset` in config; export `authRateLimit`, `passwordSchema` |
| `server/src/deletion.ts` | create | `deleteProject`, `deleteOrg`, `deleteUser`, `planUserDeletion`, `orgDeletionSummary` |
| `server/src/routes/projects.ts`, `orgs.ts`, `me.ts` | modify | the three `DELETE` routes; `requireProject` returns the project |
| `server/src/db/timelines.ts` | modify | `exportTimelines` generator |
| `server/src/routes/timelines.ts` | modify | `GET …/export` |
| `server/src/redact.ts` | create | `redactTokens` |
| `server/src/app.ts` | modify | `mailer`, `logStream` options; log serializer; register reset routes |
| `server/src/routes/context.ts` | modify | `mailer?` |
| `server/src/retention.ts` | modify | also delete stale reset tokens |
| `server/src/index.ts`, `server/src/cli.ts` | modify | build the mailer from config |
| `server/src/admin.ts` | modify | `invite create/list/revoke`, `user delete`, `org delete`; per-command options |
| `server/test/db.ts` | modify | reset `password_resets` |
| `server/test/mailer.ts` | create | `FakeMailer` |
| `server/package.json`, `package-lock.json` | modify | `nodemailer`; version `0.2.0` |
| `dashboard/src/api.ts`, `types.ts`, `test/fixtures.ts` | modify | `ApiError.body`; new fields |
| `dashboard/src/pages/ForgotPasswordPage.tsx`, `ResetPasswordPage.tsx` | create | password reset |
| `dashboard/src/pages/ProjectSettingsPage.tsx` | create | export + delete project |
| `dashboard/src/pages/LoginPage.tsx`, `InvitePage.tsx`, `OrgSettingsPage.tsx`, `UserSettingsPage.tsx`, `ProjectLayout.tsx`, `MembersPage.tsx`, `App.tsx` | modify | as described per task |
| `dashboard/src/components/ui.tsx` | modify | `TypeToConfirm` |
| `dashboard/src/theme.css` | create | tokens, base styles and utilities moved out of `index.css` |
| `site/**` | create | the landing site workspace |
| `package.json` (root) | modify | `site` workspace |
| `server/Dockerfile` | modify | copy `site/package.json` in both npm stages |
| `.github/workflows/site.yml` | create | build + deploy to GitHub Pages |
| `deploy/backup.sh`, `deploy/backup.env.example` | create | off-site backups |
| `deploy/docker-compose.yml`, `deploy/.env.example` | modify | SMTP variables; log rotation |
| `docs/self-hosting.md`, `docs/releasing.md`, `server/README.md` | modify | docs |
| `docs/superpowers/specs/2026-09-24-tripcord-hosted-beta-design.md` | modify | logging line; status |

---

### Task 1: Schema, migration and signup invites

**Files:**
- Modify: `server/src/db/schema.ts`, `server/src/db/invites.ts`, `server/src/accounts.ts`, `server/src/routes/invites.ts`, `server/test/db.ts`, `server/src/db/migrations.test.ts`, `server/src/accounts.test.ts`, `server/src/routes/invites.test.ts`
- Generate: `server/drizzle/0004_hosted_beta.sql`, `server/drizzle/meta/0004_snapshot.json`, `server/drizzle/meta/_journal.json`

**Interfaces:**
- Produces:
  - `passwordResets` table, `PasswordReset` type.
  - `InviteSummary.createdByName: string | null`.
  - `UsableInvite.orgId: string | null`, `UsableInvite.orgName: string | null`.
  - `createSignupInvite(ex): Promise<{ id: string; expiresAt: Date; token: string }>`.
  - `listPendingSignupInvites(ex): Promise<{ id: string; createdAt: Date; expiresAt: Date }[]>`.
  - `revokeSignupInvite(ex, inviteId): Promise<boolean>`.
  - `AcceptInviteResult` gains `reason: "signup_only"`.

- [x] **Step 1: Update the schema**

In `server/src/db/schema.ts`, change the two `invites` columns:

```ts
    // NULL for a signup invite, which creates a new account with its own org
    // (see signUp in accounts.ts). Only the admin CLI creates those.
    orgId: uuid("org_id").references(() => orgs.id),
```

```ts
    // NULL for invites made by the admin CLI, and once the creator deletes their account.
    createdBy: uuid("created_by").references(() => users.id),
```

After `invites`, add:

```ts
export const passwordResets = pgTable(
  "password_resets",
  {
    // SHA-256 of the tpr_ token. The token itself only ever travels in the email.
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // Set from the server's clock (not defaultNow) so the 2-minute cooldown
    // compares like with like.
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
  },
  (table) => ({
    userIdx: index("password_resets_user_idx").on(table.userId),
  })
);
```

and with the other types:

```ts
export type PasswordReset = typeof passwordResets.$inferSelect;
```

- [x] **Step 2: Generate the migration**

Run: `cd server && npx drizzle-kit generate --name hosted_beta`
Expected: `drizzle/0004_hosted_beta.sql`, plus a new snapshot and journal entry, containing:
- `CREATE TABLE IF NOT EXISTS "password_resets"`
- two `ALTER TABLE "invites" ALTER COLUMN … DROP NOT NULL`
- the foreign key to `users`
- `password_resets_user_idx`

Read the SQL. It must not drop or rewrite anything else.

- [x] **Step 3: Reset the new table in tests**

In `server/test/db.ts`, import `passwordResets`, and in `resetDb` delete it before `sessions`:

```ts
  await db.delete(invites);
  await db.delete(passwordResets);
  await db.delete(sessions);
```

- [x] **Step 4: Write the failing tests**

Append to `server/src/db/migrations.test.ts`:

```ts
describe("hosted beta migration (0004)", () => {
  it("keeps existing invites and makes org_id and created_by nullable", async () => {
    await withFreshDatabase(async (pool) => {
      const db = drizzle(pool);
      const before = migrationsBefore(4);
      try {
        await migrate(db, { migrationsFolder: before });
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      const user = await pool.query<{ id: string }>(`INSERT INTO users (email, name) VALUES ('a@example.com', 'A') RETURNING id`);
      const org = await pool.query<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Acme') RETURNING id`);
      await pool.query(
        `INSERT INTO invites (org_id, token_hash, role, created_by, expires_at) VALUES ($1, 'h', 'member', $2, now())`,
        [org.rows[0].id, user.rows[0].id]
      );

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const invites = await pool.query<{ org_id: string }>(`SELECT org_id FROM invites`);
      expect(invites.rows).toEqual([{ org_id: org.rows[0].id }]);
      const columns = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'invites' AND column_name IN ('org_id', 'created_by') ORDER BY column_name`
      );
      expect(columns.rows).toEqual([
        { column_name: "created_by", is_nullable: "YES" },
        { column_name: "org_id", is_nullable: "YES" },
      ]);
      const resets = await pool.query(`SELECT 1 FROM password_resets`);
      expect(resets.rows).toHaveLength(0);
    });
  });
});
```

In `server/src/accounts.test.ts`, add `createSignupInvite` to the `./db/invites` import. Append inside `describe("signUp")`:

```ts
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
```

and inside `describe("acceptInvite")`:

```ts
  it("refuses a signup invite for an existing user and leaves it usable", async () => {
    const user = await createTestUser(getTestDb());
    const { token } = await createSignupInvite(getTestDb());

    expect(await acceptInvite(getTestDb(), token, user.id)).toEqual({ ok: false, reason: "signup_only" });
    expect(await findUsableInvite(getTestDb(), token)).toBeDefined();
  });
```

Append a new describe to `server/src/accounts.test.ts`:

```ts
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
```

(and extend the import: `createInvite, createSignupInvite, findUsableInvite, listPendingInvites, listPendingSignupInvites, revokeSignupInvite`).

In `server/src/routes/invites.test.ts`, add `createSignupInvite` to the import from `../db/invites`, and append inside the describe:

```ts
  it("previews a signup invite with no org", async () => {
    const { app, db } = await fixture();
    const { token } = await createSignupInvite(db);
    const response = await call(app, "GET", `/api/invites/${token}`);
    expect(response.json()).toEqual({ orgName: null, role: "owner" });
  });

  it("refuses to let a logged-in user accept a signup invite", async () => {
    const { app, db, owner } = await fixture();
    const { token } = await createSignupInvite(db);
    const response = await call(app, "POST", `/api/invites/${token}/accept`, { cookie: await sessionCookie(db, owner.id) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "This invite is for creating a new account" });
    expect((await call(app, "GET", `/api/invites/${token}`)).statusCode).toBe(200);
  });

  it("signs up a new user on an invite-only instance with a signup invite", async () => {
    const { app, db } = await fixture();
    const { token } = await createSignupInvite(db);
    const response = await call(app, "POST", "/api/auth/signup", {
      body: { email: "neo@example.com", name: "Neo", password: "correct horse", inviteToken: token },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().orgs).toEqual([{ id: expect.any(String), name: "Neo's org", role: "owner" }]);
  });
```

- [x] **Step 5: Run the tests to verify they fail**

Run: `npm test -w server -- src/db/migrations.test.ts src/accounts.test.ts src/routes/invites.test.ts`
Expected: FAIL. `createSignupInvite` and the others aren't exported. `npm run typecheck -w server` also reports `invite.orgId` as possibly null in `accounts.ts`.

- [x] **Step 6: Implement**

In `server/src/db/invites.ts`:

```ts
export interface InviteSummary {
  id: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
  /** NULL once the creator has deleted their account. */
  createdByName: string | null;
}
```

```ts
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
```

In `inviteSummaries`, change `.innerJoin(users, …)` to `.leftJoin(users, eq(invites.createdBy, users.id))`. In `findUsableInvite`, change `.innerJoin(orgs, …)` to `.leftJoin(orgs, eq(invites.orgId, orgs.id))`. Then add:

```ts
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
```

In `server/src/accounts.ts`, replace the `if (invite) { … }` block in `signUp` with:

```ts
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
```

Change `AcceptInviteResult` and `acceptInvite`:

```ts
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
```

In `server/src/routes/invites.ts`, replace the accept handler's error line:

```ts
const ACCEPT_ERRORS = {
  not_found: [404, INVITE_NOT_FOUND],
  already_member: [409, "Already a member"],
  signup_only: [409, "This invite is for creating a new account"],
} as const;
```

```ts
      if (!result.ok) {
        const [status, message] = ACCEPT_ERRORS[result.reason];
        throw httpError(status, message);
      }
```

The preview already returns `{ orgName: invite.orgName, role: invite.role }`, and it's now `null` for signup invites. Update its comment: `// Public, so the invite page can show "Join <org>" (or, for a signup invite, "You're invited") before the visitor logs in.`

- [x] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS, including the existing invite, signup and isolation tests.

- [x] **Step 8: Commit**

```bash
git add server
git commit -m "feat(server): signup invites and the hosted beta schema"
```

---

### Task 2: Email configuration and the mailer

**Files:**
- Create: `server/src/email.ts`, `server/src/email.test.ts`, `server/test/mailer.ts`
- Modify: `server/src/config.ts`, `server/src/config.test.ts`, `server/src/app.ts`, `server/src/routes/context.ts`, `server/src/routes/auth.ts`, `server/src/routes/auth.test.ts`, `server/src/index.ts`, `server/package.json`, `package-lock.json`

**Interfaces:**
- Produces:
  - `interface Mail { to: string; subject: string; text: string }`.
  - `interface Mailer { send(mail: Mail): Promise<void> }`.
  - `interface EmailConfig { smtpUrl: string; from: string }`.
  - `createSmtpMailer(config: EmailConfig): Mailer`.
  - `passwordResetMail(to: string, name: string, link: string): Mail`.
  - `signupInviteMail(to: string, link: string, expiresAt: Date): Mail`.
  - `DashboardConfig.email?: EmailConfig`.
  - `AppOptions.mailer?: Mailer`, `ApiContext.mailer?: Mailer`.
  - `/api/auth/config` gains `passwordReset: boolean`.
  - `authRateLimit(ctx)` and `passwordSchema` exported from `routes/auth.ts`.
  - `FakeMailer` in `server/test/mailer.ts`.

- [x] **Step 1: Add the dependency**

Run: `npm install nodemailer -w server && npm install -D @types/nodemailer -w server`

- [x] **Step 2: Write the failing tests**

In `server/src/config.test.ts`, add `email: undefined` to the "applies defaults" expectation. Add `SMTP_URL: "smtps://u:p@smtp.example.com:465"` and `EMAIL_FROM: "Tripcord <no-reply@tripcord.dev>"` to "reads every variable", and `email: { smtpUrl: "smtps://u:p@smtp.example.com:465", from: "Tripcord <no-reply@tripcord.dev>" }` to its expectation. Then append:

```ts
  it("requires SMTP_URL and EMAIL_FROM together", () => {
    expect(() => loadDashboardConfig({ SMTP_URL: "smtp://localhost" }, "/d")).toThrow(
      "SMTP_URL and EMAIL_FROM must be set together"
    );
    expect(() => loadDashboardConfig({ EMAIL_FROM: "a@b.c" }, "/d")).toThrow(
      "SMTP_URL and EMAIL_FROM must be set together"
    );
  });

  it("rejects an SMTP_URL that isn't smtp:// or smtps://", () => {
    expect(() => loadDashboardConfig({ SMTP_URL: "https://mail.example.com", EMAIL_FROM: "a@b.c" }, "/d")).toThrow(
      "SMTP_URL must start with smtp:// or smtps://"
    );
  });
```

Create `server/src/email.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { passwordResetMail, signupInviteMail } from "./email";

describe("messages", () => {
  it("password reset: one link, its expiry, and what to do if unexpected", () => {
    const mail = passwordResetMail("ana@example.com", "Ana", "https://app.tripcord.dev/reset-password/tpr_x");
    expect(mail.to).toBe("ana@example.com");
    expect(mail.subject).toBe("Reset your Tripcord password");
    expect(mail.text).toContain("Hi Ana,");
    expect(mail.text).toContain("https://app.tripcord.dev/reset-password/tpr_x");
    expect(mail.text).toContain("one hour");
    expect(mail.text).toContain("didn't ask");
  });

  it("signup invite: the link and the expiry date", () => {
    const mail = signupInviteMail("neo@example.com", "https://app.tripcord.dev/invite/tpi_x", new Date("2026-10-01T12:00:00Z"));
    expect(mail.subject).toBe("You're invited to Tripcord");
    expect(mail.text).toContain("https://app.tripcord.dev/invite/tpi_x");
    expect(mail.text).toContain("2026-10-01");
  });
});
```

In `server/src/routes/auth.test.ts`, add `passwordReset: false` to both `/api/auth/config` expectations, and append inside that describe:

```ts
  it("reports password reset when a mailer is configured", async () => {
    const app = await buildTestApp(getTestDb(), { mailer: new FakeMailer() });
    expect((await call(app, "GET", "/api/auth/config")).json()).toMatchObject({ passwordReset: true });
  });
```

(import `FakeMailer` from `../../test/mailer`).

- [x] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- src/config.test.ts src/email.test.ts src/routes/auth.test.ts`
Expected: FAIL. The modules and fields don't exist yet.

- [x] **Step 4: Implement**

Create `server/src/email.ts`:

```ts
import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Sends plain-text email. The server has one only when SMTP is configured. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface EmailConfig {
  /** nodemailer connection URL, e.g. smtps://user:pass@smtp.example.com:465 */
  smtpUrl: string;
  /** From header, e.g. "Tripcord <no-reply@tripcord.dev>" */
  from: string;
}

export function createSmtpMailer(config: EmailConfig): Mailer {
  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    async send(mail) {
      await transport.sendMail({ from: config.from, ...mail });
    },
  };
}

// Plain text only: a greeting, one link, when it expires, and what to do if the
// reader didn't expect it. No templates, no HTML.

export function passwordResetMail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Reset your Tripcord password",
    text: [
      `Hi ${name},`,
      "",
      "Someone asked to reset the password of your Tripcord account. To choose a new one, open:",
      "",
      link,
      "",
      "The link works once, for one hour.",
      "",
      "If you didn't ask for this, ignore this email. Your password stays as it is.",
    ].join("\n"),
  };
}

export function signupInviteMail(to: string, link: string, expiresAt: Date): Mail {
  return {
    to,
    subject: "You're invited to Tripcord",
    text: [
      "Hi,",
      "",
      "You're invited to the Tripcord beta. To create your account, open:",
      "",
      link,
      "",
      `The link works once, until ${expiresAt.toISOString().slice(0, 10)}.`,
      "",
      "If you weren't expecting this, ignore this email.",
    ].join("\n"),
  };
}
```

Create `server/test/mailer.ts`:

```ts
import type { Mail, Mailer } from "../src/email";

/** Records what would have been sent. */
export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];

  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
  }
}
```

In `server/src/config.ts`, import `type EmailConfig` from `./email`, add `email?: EmailConfig;` to `DashboardConfig`, and before the `return`:

```ts
  const smtpUrl = env.SMTP_URL;
  const from = env.EMAIL_FROM;
  if (Boolean(smtpUrl) !== Boolean(from)) {
    throw new Error("SMTP_URL and EMAIL_FROM must be set together");
  }
  if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl)) {
    throw new Error("SMTP_URL must start with smtp:// or smtps://");
  }
```

and add `email: smtpUrl && from ? { smtpUrl, from } : undefined,` to the returned object.

In `server/src/routes/context.ts`, import `type Mailer` and add:

```ts
  /** Password reset (and the email it sends) is enabled only when set. */
  mailer?: Mailer;
```

In `server/src/app.ts`, add to `AppOptions`:

```ts
  /** Sends email. Password reset is enabled only when set. */
  mailer?: Mailer;
```

and `mailer: options.mailer,` to `ctx`.

In `server/src/routes/auth.ts`, export the two shared pieces:

```ts
export const passwordSchema = { type: "string", minLength: 8, maxLength: 256 } as const;

/** Per-IP limit for login, signup, password reset and account deletion. */
export function authRateLimit(ctx: ApiContext) {
  return { max: ctx.authRateLimitMax, timeWindow: "1 minute", errorResponseBuilder: rateLimitErrorBody };
}
```

Inside `registerAuthRoutes`, replace the local `authRateLimit` object with `const rateLimit = authRateLimit(ctx);`, and use `config: { rateLimit }` on signup and login. Add to the config response:

```ts
    passwordReset: ctx.mailer !== undefined,
```

In `server/src/index.ts`, import `createSmtpMailer`, and pass `mailer: dashboard.email ? createSmtpMailer(dashboard.email) : undefined,` to `buildApp`.

- [x] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add server package-lock.json
git commit -m "feat(server): optional SMTP email"
```

---

### Task 3: Password reset

**Files:**
- Create: `server/src/db/password-resets.ts`, `server/src/password-reset.ts`, `server/src/password-reset.test.ts`, `server/src/routes/password-reset.ts`, `server/src/routes/password-reset.test.ts`
- Modify: `server/src/app.ts`, `server/src/retention.ts`

**Interfaces:**
- Consumes: `Mailer`, `passwordResetMail`, `authRateLimit`, `passwordSchema`, `findUserByEmail`, `setPasswordHash`, `deleteUserSessions`.
- Produces:
  - `PASSWORD_RESET_TTL_MS` (1 hour).
  - `createPasswordReset(ex, userId, now?): Promise<string>`.
  - `latestPasswordResetAt(ex, userId): Promise<Date | undefined>`.
  - `consumePasswordReset(ex, token): Promise<string | undefined>`, returning the user id.
  - `deleteStalePasswordResets(ex): Promise<number>`.
  - `PASSWORD_RESET_COOLDOWN_MS` (2 minutes).
  - `requestPasswordReset(db, mailer, publicUrl, email): Promise<"sent" | "no_user" | "cooldown">`.
  - `resetPassword(db, token, passwordHash): Promise<boolean>`.
  - `POST /api/auth/password-reset` and `POST /api/auth/password-reset/confirm`, registered only with a mailer.

- [x] **Step 1: Write the failing tests**

Create `server/src/password-reset.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestUser, getTestDb, resetDb } from "../test/db";
import { FakeMailer } from "../test/mailer";
import { hashPassword, verifyPassword } from "./auth/password";
import { createPasswordReset, deleteStalePasswordResets } from "./db/password-resets";
import { passwordResets } from "./db/schema";
import { createSession, findSessionUser } from "./db/sessions";
import { findUserById } from "./db/users";
import { requestPasswordReset, resetPassword } from "./password-reset";

const PUBLIC_URL = "https://app.tripcord.dev";

function tokenFrom(mailer: FakeMailer, index = 0): string {
  const match = mailer.sent[index].text.match(/\/reset-password\/(tpr_[A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no reset link in the email");
  return match[1];
}

describe("requestPasswordReset", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("emails a one-hour reset link to a known address, whatever its case", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", name: "Ana" });
    const mailer = new FakeMailer();

    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, " ANA@example.com ")).toBe("sent");

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("ana@example.com");
    const [row] = await getTestDb().select().from(passwordResets).where(eq(passwordResets.userId, user.id));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(60 * 60 * 1000);
    expect(tokenFrom(mailer)).toMatch(/^tpr_[A-Za-z0-9_-]{43}$/);
  });

  it("sends nothing for an unknown address", async () => {
    const mailer = new FakeMailer();
    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "nobody@example.com")).toBe("no_user");
    expect(mailer.sent).toEqual([]);
  });

  it("allows one request per user per two minutes, and a new link replaces the old one", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com" });
    const mailer = new FakeMailer();

    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "ana@example.com")).toBe("sent");
    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "ana@example.com")).toBe("cooldown");
    expect(mailer.sent).toHaveLength(1);

    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
    await getTestDb().update(passwordResets).set({ createdAt: threeMinutesAgo }).where(eq(passwordResets.userId, user.id));
    expect(await requestPasswordReset(getTestDb(), mailer, PUBLIC_URL, "ana@example.com")).toBe("sent");

    expect(await resetPassword(getTestDb(), tokenFrom(mailer, 0), "hash")).toBe(false);
    expect(await resetPassword(getTestDb(), tokenFrom(mailer, 1), "hash")).toBe(true);
  });
});

describe("resetPassword", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("sets the password, ends every session, and works once", async () => {
    const user = await createTestUser(getTestDb(), { password: "old-password" });
    const { token: session } = await createSession(getTestDb(), user.id);
    const token = await createPasswordReset(getTestDb(), user.id);

    expect(await resetPassword(getTestDb(), token, await hashPassword("new-password"))).toBe(true);

    const updated = await findUserById(getTestDb(), user.id);
    expect(await verifyPassword("new-password", updated!.passwordHash!)).toBe(true);
    expect(await findSessionUser(getTestDb(), session)).toBeUndefined();
    expect(await resetPassword(getTestDb(), token, "hash")).toBe(false);
  });

  it("refuses an expired or unknown token", async () => {
    const user = await createTestUser(getTestDb());
    const token = await createPasswordReset(getTestDb(), user.id, new Date(Date.now() - 2 * 60 * 60 * 1000));

    expect(await resetPassword(getTestDb(), token, "hash")).toBe(false);
    expect(await resetPassword(getTestDb(), "tpr_nope", "hash")).toBe(false);
  });
});

describe("deleteStalePasswordResets", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes tokens that expired more than a day ago and keeps the rest", async () => {
    const user = await createTestUser(getTestDb());
    await createPasswordReset(getTestDb(), user.id, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    const other = await createTestUser(getTestDb());
    await createPasswordReset(getTestDb(), other.id);

    expect(await deleteStalePasswordResets(getTestDb())).toBe(1);
    const left = await getTestDb().select().from(passwordResets);
    expect(left.map((row) => row.userId)).toEqual([other.id]);
  });
});
```

Create `server/src/routes/password-reset.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { TEST_ORIGIN, buildTestApp, call } from "../../test/http";
import { FakeMailer } from "../../test/mailer";

describe("password reset routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("don't exist without a mailer", async () => {
    const app = await buildTestApp(getTestDb());
    const response = await call(app, "POST", "/api/auth/password-reset", { body: { email: "a@example.com" } });
    expect(response.statusCode).toBe(404);
  });

  it("answer 204 for known and unknown addresses alike", async () => {
    await createTestUser(getTestDb(), { email: "ana@example.com" });
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { mailer });

    const known = await call(app, "POST", "/api/auth/password-reset", { body: { email: "ana@example.com" } });
    const unknown = await call(app, "POST", "/api/auth/password-reset", { body: { email: "nobody@example.com" } });

    expect([known.statusCode, unknown.statusCode]).toEqual([204, 204]);
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
    expect(mailer.sent[0].text).toContain(`${TEST_ORIGIN}/reset-password/tpr_`);
  });

  it("reset the password from the emailed link and log the user out everywhere", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", password: "old-password" });
    const oldCookie = await sessionCookie(getTestDb(), user.id);
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { mailer });

    await call(app, "POST", "/api/auth/password-reset", { body: { email: "ana@example.com" } });
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
    const token = mailer.sent[0].text.match(/(tpr_[A-Za-z0-9_-]+)/)![1];

    const confirm = await call(app, "POST", "/api/auth/password-reset/confirm", {
      body: { token, newPassword: "new-password" },
    });
    expect(confirm.statusCode).toBe(204);

    expect((await call(app, "GET", "/api/me", { cookie: oldCookie })).statusCode).toBe(401);
    const login = await call(app, "POST", "/api/auth/login", { body: { email: "ana@example.com", password: "new-password" } });
    expect(login.statusCode).toBe(200);

    const again = await call(app, "POST", "/api/auth/password-reset/confirm", { body: { token, newPassword: "another-one" } });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: "This reset link is invalid or has expired" });
  });

  it("validates the new password like a password change", async () => {
    const app = await buildTestApp(getTestDb(), { mailer: new FakeMailer() });
    const response = await call(app, "POST", "/api/auth/password-reset/confirm", { body: { token: "tpr_x", newPassword: "short" } });
    expect(response.statusCode).toBe(400);
  });

  it("logs the send failure and still answers 204", async () => {
    await createTestUser(getTestDb(), { email: "ana@example.com" });
    const failing = { send: vi.fn().mockRejectedValue(new Error("SMTP down")) };
    const app = await buildTestApp(getTestDb(), { mailer: failing });

    const response = await call(app, "POST", "/api/auth/password-reset", { body: { email: "ana@example.com" } });

    expect(response.statusCode).toBe(204);
    await vi.waitFor(() => expect(failing.send).toHaveBeenCalledOnce());
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/password-reset.test.ts src/routes/password-reset.test.ts`
Expected: FAIL. The modules don't exist.

- [x] **Step 3: Implement**

Create `server/src/db/password-resets.ts`:

```ts
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { Executor } from "./client";
import { passwordResets } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** A new reset token for the user. Their earlier unused tokens stop working. */
export async function createPasswordReset(ex: Executor, userId: string, now = new Date()): Promise<string> {
  const { token, hash } = generateToken("tpr_");
  await ex.delete(passwordResets).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  await ex.insert(passwordResets).values({
    tokenHash: hash,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
  });
  return token;
}

export async function latestPasswordResetAt(ex: Executor, userId: string): Promise<Date | undefined> {
  const [row] = await ex
    .select({ createdAt: passwordResets.createdAt })
    .from(passwordResets)
    .where(eq(passwordResets.userId, userId))
    .orderBy(desc(passwordResets.createdAt))
    .limit(1);
  return row?.createdAt;
}

// Conditional update, like consumeInvite: of two concurrent uses of one token,
// only the first finds used_at NULL.
/** The token's user id, marking it used; undefined for an unknown, expired or used token. */
export async function consumePasswordReset(ex: Executor, token: string): Promise<string | undefined> {
  const [row] = await ex
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(
      and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date()))
    )
    .returning({ userId: passwordResets.userId });
  return row?.userId;
}

export async function deleteStalePasswordResets(ex: Executor): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await ex
    .delete(passwordResets)
    .where(lt(passwordResets.expiresAt, cutoff))
    .returning({ tokenHash: passwordResets.tokenHash });
  return deleted.length;
}
```

Create `server/src/password-reset.ts`:

```ts
import type { Database } from "./db/client";
import { consumePasswordReset, createPasswordReset, latestPasswordResetAt } from "./db/password-resets";
import { deleteUserSessions } from "./db/sessions";
import { findUserByEmail, setPasswordHash } from "./db/users";
import { passwordResetMail, type Mailer } from "./email";

export const PASSWORD_RESET_COOLDOWN_MS = 2 * 60 * 1000;

export type ResetRequestOutcome = "sent" | "no_user" | "cooldown";

// The route runs this after replying, so the outcome never reaches the requester.
export async function requestPasswordReset(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  email: string
): Promise<ResetRequestOutcome> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    return "no_user";
  }
  const last = await latestPasswordResetAt(db, user.id);
  if (last && Date.now() - last.getTime() < PASSWORD_RESET_COOLDOWN_MS) {
    return "cooldown";
  }
  const token = await createPasswordReset(db, user.id);
  await mailer.send(passwordResetMail(user.email, user.name, `${publicUrl}/reset-password/${token}`));
  return "sent";
}

/** Sets the password and ends every session. False for an unknown, expired or used token. */
export async function resetPassword(db: Database, token: string, passwordHash: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const userId = await consumePasswordReset(tx, token);
    if (!userId) {
      return false;
    }
    await setPasswordHash(tx, userId, passwordHash);
    await deleteUserSessions(tx, userId);
    return true;
  });
}
```

Create `server/src/routes/password-reset.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../auth/password";
import { normalizeEmail } from "../db/users";
import { requestPasswordReset, resetPassword } from "../password-reset";
import { authRateLimit, passwordSchema } from "./auth";
import type { ApiContext } from "./context";

interface ResetRequestBody {
  email: string;
}

interface ResetConfirmBody {
  token: string;
  newPassword: string;
}

export function registerPasswordResetRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, mailer } = ctx;
  // Without SMTP the routes don't exist, and /api/auth/config says so.
  if (!mailer) {
    return;
  }
  const rateLimit = authRateLimit(ctx);

  app.post<{ Body: ResetRequestBody }>(
    "/api/auth/password-reset",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", maxLength: 254 } },
          additionalProperties: false,
        },
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      // Started here, finished after the reply: neither the status nor the
      // response time says whether the address has an account.
      void requestPasswordReset(db, mailer, ctx.publicUrl, normalizeEmail(request.body.email)).catch((error: unknown) => {
        request.log.error({ err: error }, "password reset email failed");
      });
      return reply.code(204).send();
    }
  );

  app.post<{ Body: ResetConfirmBody }>(
    "/api/auth/password-reset/confirm",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "newPassword"],
          properties: { token: { type: "string", maxLength: 100 }, newPassword: passwordSchema },
          additionalProperties: false,
        },
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      const ok = await resetPassword(db, request.body.token, await hashPassword(request.body.newPassword));
      if (!ok) {
        return reply.code(400).send({ error: "This reset link is invalid or has expired" });
      }
      return reply.code(204).send();
    }
  );
}
```

In `server/src/app.ts`, import and call `registerPasswordResetRoutes(app, ctx);` after `registerAuthRoutes`.

In `server/src/retention.ts`, import `deleteStalePasswordResets` and add it to the `Promise.all` in `run`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): password reset by email"
```

---

### Task 4: Deletion services

**Files:**
- Create: `server/src/deletion.ts`, `server/src/deletion.test.ts`

**Interfaces:**
- Produces:
  - `deleteProject(ex: Executor, projectId: string): Promise<void>`.
  - `deleteOrg(ex: Executor, orgId: string): Promise<void>`.
  - `interface OrgRef { id: string; name: string }`.
  - `interface UserDeletionPlan { soleMemberOrgs: OrgRef[]; blockingOrgs: OrgRef[] }`.
  - `planUserDeletion(ex: Executor, userId: string): Promise<UserDeletionPlan>`.
  - `type DeleteUserResult = { ok: true; deletedOrgs: OrgRef[] } | { ok: false; reason: "sole_owner"; orgs: OrgRef[] }`.
  - `deleteUser(db: Database, userId: string): Promise<DeleteUserResult>`.
  - `orgDeletionSummary(ex: Executor, orgId: string): Promise<{ memberCount: number; projectCount: number; timelineCount: number }>`.

- [x] **Step 1: Write the failing tests**

Create `server/src/deletion.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestProject, createTestUser, getTestDb, insertTestTimeline, resetDb } from "../test/db";
import { createInvite, listPendingInvites } from "./db/invites";
import { addMember, createOrgWithOwner, findOrg, listUserOrgs } from "./db/orgs";
import { createPasswordReset } from "./db/password-resets";
import { findProjectByApiKey, listProjects } from "./db/projects";
import { apiKeys, passwordResets, sessions, timelines } from "./db/schema";
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
    await createPasswordReset(db, ana.id);

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
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/deletion.test.ts`
Expected: FAIL. `./deletion` doesn't exist.

- [x] **Step 3: Implement**

Create `server/src/deletion.ts`:

```ts
import { and, count, eq, inArray } from "drizzle-orm";
import type { Database, Executor } from "./db/client";
import { apiKeys, invites, memberships, orgs, passwordResets, projects, sessions, timelines, users } from "./db/schema";

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
    .orderBy(orgs.name);
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
    // Invites in orgs that live on keep their history, without a name.
    await tx.update(invites).set({ createdBy: null }).where(eq(invites.createdBy, userId));
    await tx.update(invites).set({ acceptedBy: null }).where(eq(invites.acceptedBy, userId));
    await tx.delete(users).where(eq(users.id, userId));
    return { ok: true, deletedOrgs: plan.soleMemberOrgs };
  });
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- src/deletion.test.ts && npm run typecheck -w server`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/deletion.ts server/src/deletion.test.ts
git commit -m "feat(server): delete projects, orgs and users"
```

---

### Task 5: Deletion routes

**Files:**
- Modify: `server/src/routes/projects.ts`, `server/src/routes/orgs.ts`, `server/src/routes/me.ts`, `server/src/routes/projects.test.ts`, `server/src/routes/orgs.test.ts`, `server/src/routes/me.test.ts`, `server/src/routes/isolation.test.ts`

**Interfaces:**
- Consumes: `deleteProject`, `deleteOrg`, `deleteUser`, `authRateLimit`, `clearSessionCookie`, `verifyPassword`.
- Produces:
  - `DELETE /api/orgs/:orgId/projects/:projectId` (owner) → `204`.
  - `DELETE /api/orgs/:orgId` (owner) → `204`.
  - `DELETE /api/me` with body `{ password? }` → `204`, or `403 { error: "Password is incorrect" }`, or `409 { error, orgs }`.
  - `requireProject` now returns `Promise<Project>`.

- [x] **Step 1: Write the failing tests**

Append to the describe in `server/src/routes/projects.test.ts`. It reuses that file's fixture; check its field names before pasting. The owner/member cookies and the org id are available as in `orgs.test.ts`.

```ts
  it("an owner deletes a project; its key stops working at ingest", async () => {
    const { app, db, org, ownerCookie } = await fixture();
    const { project, key } = await createTestProject(db, "doomed", org.id);

    const response = await call(app, "DELETE", `/api/orgs/${org.id}/projects/${project.id}`, { cookie: ownerCookie });

    expect(response.statusCode).toBe(204);
    const list = await call(app, "GET", `/api/orgs/${org.id}/projects`, { cookie: ownerCookie });
    expect(list.json().projects.map((p: { id: string }) => p.id)).not.toContain(project.id);
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/timeline",
      headers: { "x-tripcord-key": key, "content-type": "application/json" },
      payload: {},
    });
    expect(ingest.statusCode).toBe(401);
  });

  it("a member can't delete a project", async () => {
    const { app, db, org, memberCookie } = await fixture();
    const { project } = await createTestProject(db, "kept", org.id);
    const response = await call(app, "DELETE", `/api/orgs/${org.id}/projects/${project.id}`, { cookie: memberCookie });
    expect(response.statusCode).toBe(403);
  });
```

If `projects.test.ts`'s fixture has no member, create one with `createTestUser` + `addMember` in that test.

Append to `server/src/routes/orgs.test.ts`:

```ts
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
```

Append a describe to `server/src/routes/me.test.ts` (reuse its imports; add `addMember`, `createOrgWithOwner` from `../db/orgs` if missing):

```ts
describe("DELETE /api/me", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes a password user who confirms with their password, and clears the cookie", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { password: "correct horse" });
    const cookie = await sessionCookie(db, user.id);
    const app = await buildTestApp(db);

    const wrong = await call(app, "DELETE", "/api/me", { cookie, body: { password: "wrong horse" } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: "Password is incorrect" });

    const response = await call(app, "DELETE", "/api/me", { cookie, body: { password: "correct horse" } });
    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toContain("tripcord_session=;");
    expect((await call(app, "GET", "/api/me", { cookie })).statusCode).toBe(401);
  });

  it("deletes a GitHub-only user with an empty body", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { githubId: "42" });
    const app = await buildTestApp(db);
    const response = await call(app, "DELETE", "/api/me", { cookie: await sessionCookie(db, user.id), body: {} });
    expect(response.statusCode).toBe(204);
  });

  it("lists the orgs that block deletion", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    const other = await createTestUser(db);
    const team = await createOrgWithOwner(db, user.id, "Team");
    await addMember(db, team.id, other.id, "member");
    const app = await buildTestApp(db);

    const response = await call(app, "DELETE", "/api/me", { cookie: await sessionCookie(db, user.id), body: {} });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "You're the only owner of an org with other members",
      orgs: [{ id: team.id, name: "Team" }],
    });
  });
});
```

The cookie assertion must match how `clearSessionCookie` renders. Check the existing logout test in `auth.test.ts` and use the same assertion.

In `server/src/routes/isolation.test.ts`, after the last `DELETE …/members/:userId` case, append the two new routes in this order, so the owner's positive control deletes the project, then the org:

```ts
  {
    route: "DELETE /api/orgs/:orgId/projects/:projectId",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}`,
  },
  { route: "DELETE /api/orgs/:orgId", url: (f) => `/api/orgs/${f.orgId}` },
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/routes`
Expected: FAIL. The routes return 404, and isolation's "covers every registered route" fails.

- [x] **Step 3: Implement**

In `server/src/routes/projects.ts`, make `requireProject` return the project:

```ts
/** 404 unless the project exists in the org. Every project-scoped route calls it first. */
export async function requireProject(db: Database, { orgId, projectId }: ProjectParams): Promise<Project> {
  const project = isUuid(projectId) ? await findProjectInOrg(db, orgId, projectId) : undefined;
  if (!project) {
    throw httpError(404, "Not Found");
  }
  return project;
}
```

(import `type Project` from `../db/schema`). Then in `registerProjectRoutes`, add `const asOwner = [requireUser(db), requireMembership(db, "owner")];` and:

```ts
  app.delete<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId",
    { preValidation: asOwner },
    async (request, reply) => {
      const project = await requireProject(db, request.params);
      await deleteProject(db, project.id);
      return reply.code(204).send();
    }
  );
```

In `server/src/routes/orgs.ts`:

```ts
  app.delete<{ Params: OrgParams }>("/api/orgs/:orgId", { preValidation: asOwner }, async (request, reply) => {
    await deleteOrg(db, request.params.orgId);
    return reply.code(204).send();
  });
```

In `server/src/routes/me.ts`, import `clearSessionCookie`, `deleteUser` and `authRateLimit`, then add:

```ts
  // The dashboard always sends a body ({} for GitHub-only users), which the schema requires.
  app.delete<{ Body: { password?: string } }>(
    "/api/me",
    {
      preValidation: requireUser(db),
      schema: {
        body: {
          type: "object",
          properties: { password: { type: "string", maxLength: 256 } },
          additionalProperties: false,
        },
      },
      config: { rateLimit: authRateLimit(ctx) },
    },
    async (request, reply) => {
      const user = currentUser(request);
      if (user.passwordHash !== null && !(await verifyPassword(request.body.password ?? "", user.passwordHash))) {
        return reply.code(403).send({ error: "Password is incorrect" });
      }
      const result = await deleteUser(db, user.id);
      if (!result.ok) {
        return reply.code(409).send({ error: "You're the only owner of an org with other members", orgs: result.orgs });
      }
      clearSessionCookie(reply);
      return reply.code(204).send();
    }
  );
```

`routes/me.ts` importing from `routes/auth.ts`, while `auth.ts` imports `meBody` from `me.ts`, is a circular import. Both only use each other's exports inside functions at request time, so it's safe. If lint or the build objects, move `authRateLimit` and `passwordSchema` into `routes/context.ts` instead.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/routes
git commit -m "feat(server): API routes to delete projects, orgs and accounts"
```

---

### Task 6: Export

**Files:**
- Modify: `server/src/db/timelines.ts`, `server/src/routes/timelines.ts`, `server/src/routes/timelines.test.ts`, `server/src/routes/isolation.test.ts`
- Create: `server/src/db/timelines-export.test.ts`

**Interfaces:**
- Produces:
  - `interface ExportedTimeline { id; receivedAt: string; sessionId; reasonType; reason; events; meta; tags }`.
  - `exportTimelines(db, projectId, batchSize = 500): AsyncGenerator<ExportedTimeline>`.
  - `exportFilename(projectName: string, date: Date): string`.
  - `GET /api/orgs/:orgId/projects/:projectId/export` (member) → NDJSON.

- [x] **Step 1: Write the failing tests**

Create `server/src/db/timelines-export.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTestProject, getTestDb, insertTestTimeline, pgTimestampAgo, resetDb } from "../../test/db";
import { exportTimelines } from "./timelines";

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const row of rows) all.push(row);
  return all;
}

describe("exportTimelines", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("yields every timeline once, oldest first, across batches and equal timestamps", async () => {
    const db = getTestDb();
    const { project } = await createTestProject(db);
    const other = await createTestProject(db, "other", project.orgId);
    const same = pgTimestampAgo(60_000);
    const ids = [
      await insertTestTimeline(db, project.id, { receivedAt: pgTimestampAgo(120_000) }),
      await insertTestTimeline(db, project.id, { receivedAt: same }),
      await insertTestTimeline(db, project.id, { receivedAt: same }),
      await insertTestTimeline(db, project.id, { receivedAt: same }),
      await insertTestTimeline(db, project.id, { receivedAt: pgTimestampAgo(1_000) }),
    ];
    await insertTestTimeline(db, other.project.id);

    const rows = await collect(exportTimelines(db, project.id, 2));

    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
    expect(rows[0].id).toBe(ids[0]);
    expect(rows[4].id).toBe(ids[4]);
    expect(rows[0]).toEqual({
      id: ids[0],
      receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
      sessionId: "session-1",
      reasonType: "error",
      reason: { type: "error", name: "TypeError", message: "boom" },
      events: [{ timestamp: 1, type: "custom", name: "step" }],
      meta: { url: "https://shop.example.com/checkout", userAgent: "test-agent", capturedAt: 1 },
      tags: [],
    });
  });

  it("yields nothing for a project without timelines", async () => {
    const { project } = await createTestProject(getTestDb());
    expect(await collect(exportTimelines(getTestDb(), project.id))).toEqual([]);
  });
});
```

Append to `server/src/routes/timelines.test.ts` (reuse its fixture: an org, a member cookie and a project; adapt names):

```ts
describe("GET …/export", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("downloads the project's timelines as NDJSON for any member", async () => {
    const db = getTestDb();
    const owner = await createTestUser(db);
    const member = await createTestUser(db);
    const org = await createOrgWithOwner(db, owner.id, "Acme");
    await addMember(db, org.id, member.id, "member");
    const { project } = await createTestProject(db, "Web Shop!", org.id);
    await insertTestTimeline(db, project.id);
    await insertTestTimeline(db, project.id);
    const app = await buildTestApp(db);

    const response = await call(app, "GET", `/api/orgs/${org.id}/projects/${project.id}/export`, {
      cookie: await sessionCookie(db, member.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="web-shop-\d{4}-\d{2}-\d{2}\.ndjson"$/);
    const lines = response.payload.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveProperty("events");
  });
});
```

Add the case to `server/src/routes/isolation.test.ts`, right after `GET …/timelines/:timelineId`:

```ts
  {
    route: "GET /api/orgs/:orgId/projects/:projectId/export",
    url: (f) => `/api/orgs/${f.orgId}/projects/${f.projectId}/export`,
  },
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/db/timelines-export.test.ts src/routes/timelines.test.ts src/routes/isolation.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

Append to `server/src/db/timelines.ts`:

```ts
export interface ExportedTimeline {
  id: string;
  receivedAt: string;
  sessionId: string;
  reasonType: string;
  reason: unknown;
  events: unknown;
  meta: unknown;
  tags: string[];
}

/**
 * Every timeline of a project, oldest first, `batchSize` rows per query.
 * Keyset-paged on (received_at, id) with microsecond timestamps, the same way
 * listTimelines pages, so rows sharing a timestamp are neither lost nor repeated.
 */
export async function* exportTimelines(db: Database, projectId: string, batchSize = 500): AsyncGenerator<ExportedTimeline> {
  let after: Cursor | undefined;
  for (;;) {
    const conditions: SQL[] = [eq(timelines.projectId, projectId)];
    if (after) {
      conditions.push(
        sql`(${timelines.receivedAt}, ${timelines.id}) > (${after.receivedAt}::timestamp, ${after.id}::uuid)`
      );
    }
    const rows = await db
      .select({
        id: timelines.id,
        receivedAt: isoTimestamp(timelines.receivedAt),
        sessionId: timelines.sessionId,
        reasonType: timelines.reasonType,
        reason: timelines.reason,
        events: timelines.events,
        meta: timelines.meta,
        tags: timelines.tags,
      })
      .from(timelines)
      .where(whereAll(conditions))
      .orderBy(asc(timelines.receivedAt), asc(timelines.id))
      .limit(batchSize);
    yield* rows;
    if (rows.length < batchSize) {
      return;
    }
    const last = rows[rows.length - 1];
    after = { receivedAt: last.receivedAt, id: last.id };
  }
}
```

In `server/src/routes/timelines.ts`, import `Readable` from `node:stream` and `exportTimelines`, and add:

```ts
/** e.g. "web-shop-2026-09-24.ndjson". */
export function exportFilename(projectName: string, date: Date): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project";
  return `${slug}-${date.toISOString().slice(0, 10)}.ndjson`;
}

async function* ndjson(rows: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const row of rows) {
    yield `${JSON.stringify(row)}\n`;
  }
}
```

and inside `registerTimelineReadRoutes`:

```ts
  // Streamed, so a large project never sits in memory. Any member may export.
  app.get<{ Params: ProjectParams }>(
    "/api/orgs/:orgId/projects/:projectId/export",
    { preValidation: asMember },
    async (request, reply) => {
      const project = await requireProject(db, request.params);
      return reply
        .header("Content-Type", "application/x-ndjson; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${exportFilename(project.name, new Date())}"`)
        .send(Readable.from(ndjson(exportTimelines(db, project.id))));
    }
  );
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src
git commit -m "feat(server): export a project's timelines as NDJSON"
```

---

### Task 7: Logs without IPs or tokens

**Files:**
- Create: `server/src/redact.ts`, `server/src/redact.test.ts`
- Modify: `server/src/app.ts`, `server/src/app.test.ts`

**Interfaces:**
- Produces:
  - `redactTokens(url: string): string`.
  - `AppOptions.logStream?: { write(line: string): void }`.

- [x] **Step 1: Write the failing tests**

Create `server/src/redact.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactTokens } from "./redact";

describe("redactTokens", () => {
  it("hides invite, reset and key tokens, keeping their prefix", () => {
    expect(redactTokens("/api/invites/tpi_abc-DEF_123/accept")).toBe("/api/invites/tpi_[redacted]/accept");
    expect(redactTokens("/reset-password/tpr_abc")).toBe("/reset-password/tpr_[redacted]");
    expect(redactTokens("/x?key=tpk_abc&y=1")).toBe("/x?key=tpk_[redacted]&y=1");
  });

  it("leaves other URLs alone", () => {
    expect(redactTokens("/api/orgs/1/projects")).toBe("/api/orgs/1/projects");
  });
});
```

Append to `server/src/app.test.ts`:

```ts
describe("request logs", () => {
  it("carry neither client IPs nor tokens", async () => {
    const lines: string[] = [];
    const app = await buildApp(getTestDb(), { logLevel: "info", logStream: { write: (line) => lines.push(line) } });

    await app.inject({ method: "GET", url: "/api/invites/tpi_supersecret" });

    const logged = lines.join("");
    expect(logged).toContain("tpi_[redacted]");
    expect(logged).not.toContain("supersecret");
    expect(logged).not.toContain("remoteAddress");
    expect(logged).not.toContain("127.0.0.1");
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/redact.test.ts src/app.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

Create `server/src/redact.ts`:

```ts
// Invite (tpi_) and password-reset (tpr_) tokens travel in URLs, and a leaked
// log line must not be a working link. API keys (tpk_) never should, but are
// covered by the same pattern.
const TOKEN = /\btp[a-z]_[A-Za-z0-9_-]+/g;

export function redactTokens(url: string): string {
  return url.replace(TOKEN, (token) => `${token.slice(0, 4)}[redacted]`);
}
```

In `server/src/app.ts`, add to `AppOptions`:

```ts
  /** Where logs go. Default stdout; tests pass a stream to read them. */
  logStream?: { write(line: string): void };
```

and replace the `logger` option in `Fastify({ … })`:

```ts
    logger: {
      level: options.logLevel ?? "info",
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Replaces the default, which logs the client's IP and port. The privacy
      // page promises no IPs in logs; rate limiters use them in memory only.
      serializers: {
        req: (request: { method: string; url: string }) => ({ method: request.method, url: redactTokens(request.url) }),
      },
    },
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS. If Fastify's logger typing rejects the serializer's parameter type, type it as `FastifyRequest` from `fastify`.

- [x] **Step 5: Commit**

```bash
git add server/src
git commit -m "feat(server): keep client IPs and tokens out of logs"
```

---

### Task 8: Admin CLI

**Files:**
- Modify: `server/src/admin.ts`, `server/src/admin.test.ts`, `server/src/cli.ts`, `server/README.md`

**Interfaces:**
- Consumes: `createSignupInvite`, `listPendingSignupInvites`, `revokeSignupInvite`, `signupInviteMail`, `planUserDeletion`, `deleteUser`, `orgDeletionSummary`, `deleteOrg`, `EMAIL_PATTERN`.
- Produces:
  - `interface CliDeps { publicUrl: string; mailer?: Mailer }`.
  - `runCli(argv, db, out, deps: CliDeps = { publicUrl: "http://localhost:3000" })`.
  - Commands: `invite create [--email <address>]`, `invite list`, `invite revoke <inviteId>`, `user delete <email> [--yes]`, `org delete <orgId> [--yes]`.

- [x] **Step 1: Write the failing tests**

In `server/src/admin.test.ts`, change `run` to take deps:

```ts
async function run(argv: string[], deps?: CliDeps) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, getTestDb(), {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  }, deps);
  return { code, stdout, stderr };
}
```

(import `type CliDeps`), then append:

```ts
  describe("invite", () => {
    it("create prints a signup link once, and list/revoke manage it", async () => {
      const result = await run(["invite", "create"], { publicUrl: "https://app.tripcord.dev" });
      expect(result.code).toBe(0);
      expect(result.stdout[1]).toMatch(/^https:\/\/app\.tripcord\.dev\/invite\/tpi_[A-Za-z0-9_-]{43}$/);
      expect(result.stdout[2]).toBe("Store this link now. It will not be shown again.");
      const id = result.stdout[0].match(/signup invite ([0-9a-f-]{36})/)![1];

      const list = await run(["invite", "list"]);
      expect(list.stdout[0]).toMatch(/^ID\s+CREATED\s+EXPIRES$/);
      expect(list.stdout[1]).toContain(id);

      expect((await run(["invite", "revoke", id])).code).toBe(0);
      expect((await run(["invite", "list"])).stdout).toEqual(["No pending signup invites."]);
      expect((await run(["invite", "revoke", id])).code).toBe(1);
    });

    it("create --email sends the link", async () => {
      const mailer = new FakeMailer();
      const result = await run(["invite", "create", "--email", "Neo@Example.com"], { publicUrl: "https://app.tripcord.dev", mailer });
      expect(result.code).toBe(0);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0].to).toBe("neo@example.com");
      expect(mailer.sent[0].text).toContain(result.stdout[1]);
      expect(result.stdout[2]).toBe("Sent to neo@example.com");
    });

    it("create --email without SMTP is a usage error that creates nothing", async () => {
      const result = await run(["invite", "create", "--email", "neo@example.com"]);
      expect(result.code).toBe(2);
      expect(result.stderr[0]).toBe("--email needs SMTP_URL and EMAIL_FROM to be set");
      expect((await run(["invite", "list"])).stdout).toEqual(["No pending signup invites."]);
    });

    it("rejects --email on other commands", async () => {
      const result = await run(["org", "list", "--email", "a@b.c"]);
      expect(result.code).toBe(2);
      expect(result.stderr[0]).toBe("Unknown option: --email");
    });
  });

  describe("user delete", () => {
    it("previews without --yes, then deletes with it", async () => {
      const user = await createTestUser(getTestDb(), { email: "ana@example.com", name: "Ana" });
      const org = await createOrgWithOwner(getTestDb(), user.id, "Solo");

      const preview = await run(["user", "delete", "ana@example.com"]);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toEqual([
        "User ana@example.com (Ana)",
        `Also deletes 1 org where they're the only member: Solo (${org.id})`,
      ]);
      expect(preview.stderr).toEqual(["Nothing deleted. Run again with --yes to delete."]);
      expect(await findUserById(getTestDb(), user.id)).toBeDefined();

      const done = await run(["user", "delete", "ana@example.com", "--yes"]);
      expect(done.code).toBe(0);
      expect(done.stdout.at(-1)).toBe("Deleted user ana@example.com");
      expect(await findUserById(getTestDb(), user.id)).toBeUndefined();
    });

    it("refuses when they're the only owner of an org with other members", async () => {
      const user = await createTestUser(getTestDb(), { email: "ana@example.com" });
      const other = await createTestUser(getTestDb());
      const team = await createOrgWithOwner(getTestDb(), user.id, "Team");
      await addMember(getTestDb(), team.id, other.id, "member");

      const result = await run(["user", "delete", "ana@example.com", "--yes"]);
      expect(result.code).toBe(1);
      expect(result.stderr[0]).toBe(
        `ana@example.com is the only owner of orgs with other members: Team (${team.id}). Make someone else an owner or delete those orgs first.`
      );
    });
  });

  describe("org delete", () => {
    it("previews without --yes, then deletes with it", async () => {
      const owner = await createTestUser(getTestDb());
      const org = await createOrgWithOwner(getTestDb(), owner.id, "Acme");
      const { project } = await createTestProject(getTestDb(), "web", org.id);
      await insertTestTimeline(getTestDb(), project.id);

      const preview = await run(["org", "delete", org.id]);
      expect(preview.code).toBe(2);
      expect(preview.stdout).toEqual([`Org Acme (${org.id}): 1 member, 1 project, 1 timeline`]);

      const done = await run(["org", "delete", org.id, "--yes"]);
      expect(done.code).toBe(0);
      expect(done.stdout.at(-1)).toBe("Deleted org Acme");
      expect(await findOrg(getTestDb(), org.id)).toBeUndefined();
    });
  });
```

(imports: `FakeMailer` from `../test/mailer`; `addMember`, `createOrgWithOwner`, `findOrg` from `./db/orgs`; `insertTestTimeline` from `../test/db`.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- src/admin.test.ts`
Expected: FAIL.

- [x] **Step 3: Implement**

In `server/src/admin.ts`:

1. Extend `USAGE`'s command list:

```
  invite create [--email <address>]       Create a signup invite (a new account with its own org); print or email its link
  invite list                             List pending signup invites
  invite revoke <inviteId>                Revoke a pending signup invite
  user delete <email> [--yes]             Delete a user and the orgs where they're the only member
  org delete <orgId> [--yes]              Delete an org with its projects, keys and timelines
```

2. Add deps and per-command options:

```ts
export interface CliDeps {
  /** Invite links point here. */
  publicUrl: string;
  /** Set when SMTP is configured; `invite create --email` needs it. */
  mailer?: Mailer;
}

// Which options each command accepts. --help works everywhere.
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  "project create": ["org"],
  "invite create": ["email"],
  "user delete": ["yes"],
  "org delete": ["yes"],
};
```

`runCli` gets a fourth parameter, `deps: CliDeps = { publicUrl: "http://localhost:3000" }`. Replace the `--org` check with:

```ts
    for (const option of ["org", "email", "yes"] as const) {
      if (values[option] !== undefined && !(COMMAND_OPTIONS[command] ?? []).includes(option)) {
        throw new CliError(`Unknown option: --${option}`, 2, true);
      }
    }
```

Add to `parseArgs`' options: `email: { type: "string" }, yes: { type: "boolean" }`, and widen the returned `values` type to match.

3. New switch cases:

```ts
      case "invite create":
        noArgs(rest);
        return await inviteCreate(db, out, deps, values.email);
      case "invite list":
        noArgs(rest);
        return await inviteList(db, out);
      case "invite revoke":
        return await inviteRevoke(db, out, parseId(singleArg(rest, "<inviteId>")));
      case "user delete":
        return await userDelete(db, out, singleArg(rest, "<email>"), values.yes === true);
      case "org delete":
        return await orgDelete(db, out, parseId(singleArg(rest, "<orgId>")), values.yes === true);
```

4. The handlers:

```ts
const NOT_CONFIRMED = "Nothing deleted. Run again with --yes to delete.";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function orgRefs(orgs: OrgRef[]): string {
  return orgs.map((org) => `${stripControlChars(org.name)} (${org.id})`).join(", ");
}

async function inviteCreate(db: Database, out: CliOutput, deps: CliDeps, rawEmail: string | undefined): Promise<number> {
  const email = rawEmail === undefined ? undefined : normalizeEmail(rawEmail);
  if (email !== undefined && !EMAIL_PATTERN.test(email)) {
    throw new CliError(`Invalid email: ${rawEmail}`, 2);
  }
  if (email !== undefined && !deps.mailer) {
    throw new CliError("--email needs SMTP_URL and EMAIL_FROM to be set", 2);
  }
  const { id, expiresAt, token } = await createSignupInvite(db);
  const link = `${deps.publicUrl}/invite/${token}`;
  out.stdout(`Created signup invite ${id}, expires ${expiresAt.toISOString()}`);
  out.stdout(link);
  if (email === undefined || !deps.mailer) {
    out.stdout("Store this link now. It will not be shown again.");
    return 0;
  }
  try {
    await deps.mailer.send(signupInviteMail(email, link, expiresAt));
  } catch (error) {
    out.stderr(`Sending failed: ${error instanceof Error ? error.message : String(error)}`);
    out.stderr("The link above still works. Send it yourself, or revoke it with: invite revoke " + id);
    return 1;
  }
  out.stdout(`Sent to ${email}`);
  return 0;
}

async function inviteList(db: Database, out: CliOutput): Promise<number> {
  const invites = await listPendingSignupInvites(db);
  if (invites.length === 0) {
    out.stdout("No pending signup invites.");
    return 0;
  }
  const rows = invites.map((i) => [i.id, i.createdAt.toISOString(), i.expiresAt.toISOString()]);
  formatTable(["ID", "CREATED", "EXPIRES"], rows).forEach((line) => out.stdout(line));
  return 0;
}

async function inviteRevoke(db: Database, out: CliOutput, inviteId: string): Promise<number> {
  if (!(await revokeSignupInvite(db, inviteId))) {
    throw new CliError(`Pending signup invite not found: ${inviteId}`, 1);
  }
  out.stdout(`Revoked signup invite ${inviteId}`);
  return 0;
}

async function userDelete(db: Database, out: CliOutput, email: string, confirmed: boolean): Promise<number> {
  const user = await findUserByEmail(db, email);
  if (!user) {
    throw new CliError(`User not found: ${email}`, 1);
  }
  const plan = await planUserDeletion(db, user.id);
  if (plan.blockingOrgs.length > 0) {
    throw new CliError(
      `${user.email} is the only owner of orgs with other members: ${orgRefs(plan.blockingOrgs)}. Make someone else an owner or delete those orgs first.`,
      1
    );
  }
  out.stdout(`User ${user.email} (${stripControlChars(user.name)})`);
  if (plan.soleMemberOrgs.length > 0) {
    const n = plan.soleMemberOrgs.length;
    out.stdout(`Also deletes ${plural(n, "org")} where they're the only member: ${orgRefs(plan.soleMemberOrgs)}`);
  }
  if (!confirmed) {
    throw new CliError(NOT_CONFIRMED, 2);
  }
  const result = await deleteUser(db, user.id);
  if (!result.ok) {
    // Someone joined or was promoted since the plan was read.
    throw new CliError(`${user.email} became the only owner of an org with other members: ${orgRefs(result.orgs)}`, 1);
  }
  out.stdout(`Deleted user ${user.email}`);
  return 0;
}

async function orgDelete(db: Database, out: CliOutput, orgId: string, confirmed: boolean): Promise<number> {
  const org = await findOrg(db, orgId);
  if (!org) {
    throw new CliError(`Org not found: ${orgId}`, 1);
  }
  const summary = await orgDeletionSummary(db, orgId);
  out.stdout(
    `Org ${stripControlChars(org.name)} (${org.id}): ${plural(summary.memberCount, "member")}, ${plural(summary.projectCount, "project")}, ${plural(summary.timelineCount, "timeline")}`
  );
  if (!confirmed) {
    throw new CliError(NOT_CONFIRMED, 2);
  }
  await deleteOrg(db, orgId);
  out.stdout(`Deleted org ${stripControlChars(org.name)}`);
  return 0;
}
```

(imports: `type Mailer`, `signupInviteMail` from `./email`; `createSignupInvite`, `listPendingSignupInvites`, `revokeSignupInvite` from `./db/invites`; `deleteOrg`, `deleteUser`, `orgDeletionSummary`, `planUserDeletion`, `type OrgRef` from `./deletion`; `normalizeEmail` alongside `findUserByEmail`; `EMAIL_PATTERN` from `./routes/auth`.)

In `server/src/cli.ts`, build the deps from the same configuration the server reads:

```ts
  const config = loadDashboardConfig(process.env, "");
  const deps = { publicUrl: config.publicUrl, mailer: config.email ? createSmtpMailer(config.email) : undefined };
```

and pass `deps` as `runCli`'s fourth argument.

In `server/README.md`, add the five commands to "The admin CLI" table, with the same wording as `USAGE`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server && npm run typecheck -w server && npm run lint -w server`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): admin CLI for signup invites and deletions"
```

---

### Task 9: Dashboard — password reset and signup invites

**Files:**
- Create: `dashboard/src/pages/ForgotPasswordPage.tsx`, `dashboard/src/pages/ResetPasswordPage.tsx`, `dashboard/src/pages/reset.test.tsx`
- Modify: `dashboard/src/api.ts`, `dashboard/src/types.ts`, `dashboard/src/test/fixtures.ts`, `dashboard/src/App.tsx`, `dashboard/src/pages/LoginPage.tsx`, `dashboard/src/pages/InvitePage.tsx`, `dashboard/src/pages/MembersPage.tsx`, `dashboard/src/pages/invite.test.tsx`

**Interfaces:**
- Produces:
  - `ApiError.body: unknown`: the parsed error response.
  - `AuthConfig.passwordReset: boolean`.
  - `InvitePreview.orgName: string | null`.
  - `Invite.createdByName: string | null`.
  - Routes `/reset-password` and `/reset-password/:token`.

- [x] **Step 1: Types, fixtures and `ApiError`**

In `dashboard/src/api.ts`:

```ts
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed response body, for errors that carry more than a message. */
    readonly body: unknown = undefined
  ) {
    super(message);
  }
}
```

and throw `new ApiError(response.status, data.error ?? `Request failed (${response.status})`, data)`.

In `dashboard/src/types.ts`: add `passwordReset: boolean;` to `AuthConfig`. Make `InvitePreview.orgName: string | null` with the comment `/** null for a signup invite, which creates a new account with its own org. */`. Make `Invite.createdByName: string | null`.

In `dashboard/src/test/fixtures.ts`: `CONFIG_OPEN` gets `passwordReset: true`, and `CONFIG_CLOSED` gets `passwordReset: false`.

In `dashboard/src/pages/MembersPage.tsx`, line 141: `Created by {invite.createdByName ?? "a deleted user"}`.

In `dashboard/src/pages/InvitePage.tsx`'s accept `onSuccess`, use `name: invite.data?.orgName ?? ""`. That branch only runs for org invites.

- [x] **Step 2: Write the failing tests**

Create `dashboard/src/pages/reset.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_CLOSED, CONFIG_OPEN } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const LOGGED_OUT = { "GET /api/me": { status: 401, body: { error: "Not logged in" } } };

describe("password reset", () => {
  it("login offers 'Forgot password?' only when the server can send email", async () => {
    mockApi({ ...LOGGED_OUT, "GET /api/auth/config": { body: CONFIG_OPEN } });
    renderApp("/login");
    expect(await screen.findByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/reset-password");
  });

  it("login hides the link without email", async () => {
    mockApi({ ...LOGGED_OUT, "GET /api/auth/config": { body: CONFIG_CLOSED } });
    renderApp("/login");
    await screen.findByRole("button", { name: "Log in" });
    expect(screen.queryByRole("link", { name: "Forgot password?" })).not.toBeInTheDocument();
  });

  it("requests a link and says to check email, whether or not the account exists", async () => {
    const calls = mockApi({ ...LOGGED_OUT, "POST /api/auth/password-reset": { status: 204 } });
    const user = userEvent.setup();
    renderApp("/reset-password");

    await user.type(await screen.findByLabelText("Email"), "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ email: "ana@example.com" });
  });

  it("sets a new password from the link, then sends the user to log in", async () => {
    const calls = mockApi({
      ...LOGGED_OUT,
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "POST /api/auth/password-reset/confirm": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/reset-password/tpr_tok");

    await user.type(await screen.findByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Repeat new password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login?reset=1"));
    expect(await screen.findByText("Password changed. Log in with your new password.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ token: "tpr_tok", newPassword: "new-password" });
  });

  it("won't submit mismatched passwords", async () => {
    mockApi(LOGGED_OUT);
    const user = userEvent.setup();
    renderApp("/reset-password/tpr_tok");

    await user.type(await screen.findByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Repeat new password"), "new-passw0rd");

    expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set password" })).toBeDisabled();
  });

  it("explains a dead link and offers a new one", async () => {
    mockApi({
      ...LOGGED_OUT,
      "POST /api/auth/password-reset/confirm": { status: 400, body: { error: "This reset link is invalid or has expired" } },
    });
    const user = userEvent.setup();
    renderApp("/reset-password/tpr_old");

    await user.type(await screen.findByLabelText("New password"), "new-password");
    await user.type(screen.getByLabelText("Repeat new password"), "new-password");
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText("This reset link is invalid or has expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/reset-password");
  });
});
```

Append to `dashboard/src/pages/invite.test.tsx`:

```tsx
const SIGNUP_PREVIEW = { "GET /api/invites/tpi_new": { body: { orgName: null, role: "owner" } } };

describe("signup invite page", () => {
  it("offers a logged-out visitor a new account", async () => {
    mockApi({ ...SIGNUP_PREVIEW, "GET /api/me": { status: 401, body: { error: "Not logged in" } } });
    renderApp("/invite/tpi_new");

    expect(await screen.findByRole("heading", { name: "You're invited to Tripcord" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create your account" })).toHaveAttribute("href", "/signup?invite=tpi_new");
    expect(screen.queryByRole("button", { name: "Accept invite" })).not.toBeInTheDocument();
  });

  it("asks a logged-in user to log out first", async () => {
    const calls = mockApi({ ...SIGNUP_PREVIEW, "GET /api/me": { body: ME }, "POST /api/auth/logout": { status: 204 } });
    const user = userEvent.setup();
    renderApp("/invite/tpi_new");

    expect(await screen.findByText(/This invite is for creating a new account/)).toBeInTheDocument();
    mockApi({ ...SIGNUP_PREVIEW, "GET /api/me": { status: 401, body: { error: "Not logged in" } } });
    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("link", { name: "Create your account" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/auth/logout")).toBe(true);
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `npm test -w dashboard -- src/pages/reset.test.tsx src/pages/invite.test.tsx`
Expected: FAIL.

- [x] **Step 4: Implement**

Create `dashboard/src/pages/ForgotPasswordPage.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";

// The server answers 204 whether or not the address has an account, so this
// page says the same thing either way.
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const request = useMutation({ mutationFn: () => api("POST", "/api/auth/password-reset", { email }) });

  if (request.isSuccess) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-muted">
          If {email} has an account, we've sent it a link to choose a new password. The link works for one hour.
        </p>
        <Link className="text-sm text-accent hover:underline" to="/login">
          Back to log in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset your password">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          request.mutate();
        }}
      >
        <TextField label="Email" type="email" autoComplete="email" value={email} onChange={setEmail} required />
        <ErrorText error={request.error} />
        <Button type="submit" className="w-full" disabled={request.isPending}>
          Send reset link
        </Button>
      </form>
      <Link className="text-sm text-accent hover:underline" to="/login">
        Back to log in
      </Link>
    </AuthCard>
  );
}
```

Create `dashboard/src/pages/ResetPasswordPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";

// Doesn't log the user in: the server ends every session, and a leaked link
// alone should never become one.
export function ResetPasswordPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const reset = useMutation({
    mutationFn: () => api("POST", "/api/auth/password-reset/confirm", { token, newPassword: password }),
    onSuccess: () => navigate("/login?reset=1", { replace: true }),
  });
  const mismatch = repeat !== "" && repeat !== password;

  return (
    <AuthCard title="Choose a new password">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          reset.mutate();
        }}
      >
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          maxLength={256}
        />
        <TextField
          label="Repeat new password"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={setRepeat}
          required
        />
        {mismatch && <p className="text-sm text-danger">The passwords don't match.</p>}
        <ErrorText error={reset.error} />
        <Button type="submit" className="w-full" disabled={reset.isPending || mismatch}>
          Set password
        </Button>
      </form>
      {reset.error && (
        <Link className="text-sm text-accent hover:underline" to="/reset-password">
          Request a new link
        </Link>
      )}
    </AuthCard>
  );
}
```

In `dashboard/src/App.tsx`, next to `/login`:

```tsx
      <Route path="/reset-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
```

In `dashboard/src/pages/LoginPage.tsx`: after the `errorCode` alert, add

```tsx
      {params.get("reset") && <p className="text-sm text-ok">Password changed. Log in with your new password.</p>}
```

and after the password `TextField`:

```tsx
        {config.data?.passwordReset && (
          <Link className="block text-sm text-accent hover:underline" to="/reset-password">
            Forgot password?
          </Link>
        )}
```

In `dashboard/src/pages/InvitePage.tsx`, add a logout mutation:

```tsx
  const logout = useMutation({
    mutationFn: () => api("POST", "/api/auth/logout"),
    // Refetches /api/me, which now fails, so the page shows the logged-out choices.
    onSuccess: () => queryClient.resetQueries({ queryKey: queryKeys.me }),
  });
```

and, after the loading check, before the org-invite card:

```tsx
  if (invite.data.orgName === null) {
    return (
      <AuthCard title="You're invited to Tripcord">
        <p className="text-sm text-muted">This invite creates a new Tripcord account with its own organization.</p>
        {me.data ? (
          <>
            <p className="text-sm text-muted">
              You're signed in as {me.data.user.email}. This invite is for creating a new account. Log out to use it.
            </p>
            <ErrorText error={logout.error} />
            <Button className="w-full" variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Log out
            </Button>
          </>
        ) : (
          <Link className="text-sm text-accent hover:underline" to={`/signup?invite=${token}`}>
            Create your account
          </Link>
        )}
      </AuthCard>
    );
  }
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npm test -w dashboard && npm run typecheck -w dashboard && npm run lint -w dashboard`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add dashboard
git commit -m "feat(dashboard): password reset and signup invites"
```

---

### Task 10: Dashboard — export and the delete sections

**Files:**
- Create: `dashboard/src/pages/ProjectSettingsPage.tsx`, `dashboard/src/pages/danger.test.tsx`
- Modify: `dashboard/src/components/ui.tsx`, `dashboard/src/App.tsx`, `dashboard/src/pages/ProjectLayout.tsx`, `dashboard/src/pages/OrgSettingsPage.tsx`, `dashboard/src/pages/UserSettingsPage.tsx`

**Interfaces:**
- Produces:
  - `TypeToConfirm({ label, expected, buttonLabel, pending, onConfirm })`.
  - Route `orgs/:orgId/projects/:projectId/settings`.

- [x] **Step 1: Write the failing tests**

Create `dashboard/src/pages/danger.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CONFIG_OPEN, ME, ORG_ID } from "../test/fixtures";
import { mockApi, renderApp } from "../test/utils";

const PROJECT = { id: "p-1", orgId: ORG_ID, name: "web", createdAt: "2026-09-01T00:00:00.000Z", activeKeyCount: 1 };
const MEMBER_ME = { ...ME, orgs: [{ ...ME.orgs[0], role: "member" as const }] };

describe("project settings", () => {
  it("links the NDJSON export", async () => {
    mockApi({ "GET /api/me": { body: ME }, [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } } });
    renderApp(`/orgs/${ORG_ID}/projects/p-1/settings`);
    expect(await screen.findByRole("link", { name: "Export timelines" })).toHaveAttribute(
      "href",
      `/api/orgs/${ORG_ID}/projects/p-1/export`
    );
  });

  it("an owner deletes the project after typing its name", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } },
      [`DELETE /api/orgs/${ORG_ID}/projects/p-1`]: { status: 204 },
    });
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/projects/p-1/settings`);

    const button = await screen.findByRole("button", { name: "Delete project" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Type "web" to confirm'), "web");
    await user.click(button);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/orgs/${ORG_ID}/projects`));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("a member can export but not delete", async () => {
    mockApi({ "GET /api/me": { body: MEMBER_ME }, [`GET /api/orgs/${ORG_ID}/projects`]: { body: { projects: [PROJECT] } } });
    renderApp(`/orgs/${ORG_ID}/projects/p-1/settings`);
    expect(await screen.findByText("Only owners can delete a project.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument();
  });
});

describe("org settings", () => {
  it("an owner deletes the org after typing its name and leaves it", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      [`DELETE /api/orgs/${ORG_ID}`]: { status: 204 },
    });
    const user = userEvent.setup();
    renderApp(`/orgs/${ORG_ID}/settings`);

    await user.type(await screen.findByLabelText('Type "Acme" to confirm'), "Acme");
    await user.click(screen.getByRole("button", { name: "Delete organization" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/orgs/new"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("account settings", () => {
  it("deletes the account with the password and goes to login", async () => {
    const calls = mockApi({
      "GET /api/me": { body: ME },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "DELETE /api/me": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Delete account" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ password: "correct horse" });
  });

  it("a GitHub-only user confirms by typing their email", async () => {
    const calls = mockApi({
      "GET /api/me": { body: { ...ME, user: { ...ME.user, hasPassword: false, githubConnected: true } } },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "DELETE /api/me": { status: 204 },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText('Type "ana@example.com" to confirm'), "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Delete account" }));

    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({}));
  });

  it("lists the orgs that block deletion", async () => {
    mockApi({
      "GET /api/me": { body: ME },
      "GET /api/auth/config": { body: CONFIG_OPEN },
      "DELETE /api/me": {
        status: 409,
        body: { error: "You're the only owner of an org with other members", orgs: [{ id: ORG_ID, name: "Acme" }] },
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    await user.type(await screen.findByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Delete account" }));

    expect(await screen.findByRole("link", { name: "Acme" })).toHaveAttribute("href", `/orgs/${ORG_ID}/members`);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npm test -w dashboard -- src/pages/danger.test.tsx`
Expected: FAIL.

- [x] **Step 3: Implement**

Append to `dashboard/src/components/ui.tsx`:

```tsx
/** A destructive action behind typing `expected` (a name or an email) exactly. */
export function TypeToConfirm({
  label,
  expected,
  buttonLabel,
  pending,
  onConfirm,
}: {
  label: string;
  expected: string;
  buttonLabel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <TextField className="min-w-48 flex-1" label={label} value={typed} onChange={setTyped} autoComplete="off" />
      <Button type="submit" variant="danger" disabled={pending || typed !== expected}>
        {buttonLabel}
      </Button>
    </form>
  );
}
```

Create `dashboard/src/pages/ProjectSettingsPage.tsx`:

```tsx
import { useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { Card, ErrorText, TypeToConfirm } from "../components/ui";
import { queryKeys, useOrgRole, useProjects } from "../queries";
import type { Project } from "../types";

export function ProjectSettingsPage() {
  const { orgId = "", projectId = "" } = useParams();
  const project = useProjects(orgId).data?.find((p) => p.id === projectId); // ProjectLayout handles "not found"
  const role = useOrgRole(orgId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/orgs/${orgId}/projects/${projectId}`),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects(orgId) });
      queryClient.setQueryData<Project[]>(queryKeys.projects(orgId), (old) => old?.filter((p) => p.id !== projectId));
      navigate(`/orgs/${orgId}/projects`, { replace: true });
    },
  });

  if (!project) {
    return null;
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-3">
        <h2 className="font-medium">Export</h2>
        <p className="text-sm text-muted">
          Download every timeline of this project as NDJSON: one JSON object per line, oldest first.
        </p>
        <a
          href={`/api/orgs/${orgId}/projects/${projectId}/export`}
          download
          className="inline-flex rounded-lg border border-border bg-raised px-3.5 py-2 text-sm font-medium hover:border-muted/50"
        >
          Export timelines
        </a>
      </Card>
      <Card className="space-y-3">
        <h2 className="font-medium text-danger">Delete project</h2>
        {role === "owner" ? (
          <>
            <p className="text-sm text-muted">
              Deletes the project, its API keys and all its timelines. Apps still sending with its keys get 401. This
              can't be undone.
            </p>
            <TypeToConfirm
              label={`Type "${project.name}" to confirm`}
              expected={project.name}
              buttonLabel="Delete project"
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
            <ErrorText error={remove.error} />
          </>
        ) : (
          <p className="text-sm text-muted">Only owners can delete a project.</p>
        )}
      </Card>
    </div>
  );
}
```

In `dashboard/src/App.tsx`, inside the `projects/:projectId` route: `<Route path="settings" element={<ProjectSettingsPage />} />`. In `dashboard/src/pages/ProjectLayout.tsx`, add a third tab:

```tsx
        <NavLink to={`${base}/settings`} className={tabClass}>
          Settings
        </NavLink>
```

In `dashboard/src/pages/OrgSettingsPage.tsx`, add `useNavigate`, `TypeToConfirm`, and:

```tsx
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api("DELETE", `/api/orgs/${orgId}`),
    onSuccess: async () => {
      // As when leaving an org: an in-flight /api/me must not bring the org back.
      await queryClient.cancelQueries({ queryKey: queryKeys.me });
      queryClient.setQueryData<Me>(queryKeys.me, (me) => me && { ...me, orgs: me.orgs.filter((o) => o.id !== orgId) });
      navigate("/", { replace: true });
    },
  });
```

and after the rename card:

```tsx
      <Card className="space-y-3">
        <h2 className="font-medium text-danger">Delete organization</h2>
        <p className="text-sm text-muted">
          Deletes the organization with all its projects, API keys and timelines, and removes every member. Members
          keep their accounts. This can't be undone.
        </p>
        <TypeToConfirm
          label={`Type "${org.name}" to confirm`}
          expected={org.name}
          buttonLabel="Delete organization"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
        <ErrorText error={remove.error} />
      </Card>
```

`OrgSettingsPage` reads `org` with a `!`. After the cache update removes the org, the navigate in the same callback unmounts the page. If a render slips in between, the `OrgLayout` membership check shows "not found" first. Confirm this doesn't crash by running the test.

In `dashboard/src/pages/UserSettingsPage.tsx`, add `Link`, `useNavigate`, `ApiError`, and:

```tsx
  const navigate = useNavigate();
  const [confirmation, setConfirmation] = useState("");
  const deleteAccount = useMutation({
    mutationFn: () => api("DELETE", "/api/me", me.user.hasPassword ? { password: confirmation } : {}),
    onSuccess: () => {
      navigate("/login", { replace: true });
      queryClient.clear();
    },
  });
  const blocking =
    deleteAccount.error instanceof ApiError && deleteAccount.error.status === 409
      ? ((deleteAccount.error.body as { orgs?: { id: string; name: string }[] }).orgs ?? [])
      : [];
  const confirmed = me.user.hasPassword ? confirmation !== "" : confirmation === me.user.email;
```

and a last card:

```tsx
      <Card className="space-y-3">
        <h2 className="font-medium text-danger">Delete account</h2>
        <p className="text-sm text-muted">
          Deletes your account and every organization where you're the only member, with their projects and
          timelines. This can't be undone.
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            deleteAccount.mutate();
          }}
        >
          {me.user.hasPassword ? (
            <TextField
              className="min-w-48 flex-1"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={confirmation}
              onChange={setConfirmation}
            />
          ) : (
            <TextField
              className="min-w-48 flex-1"
              label={`Type "${me.user.email}" to confirm`}
              value={confirmation}
              onChange={setConfirmation}
              autoComplete="off"
            />
          )}
          <Button type="submit" variant="danger" disabled={deleteAccount.isPending || !confirmed}>
            Delete account
          </Button>
        </form>
        {blocking.length > 0 ? (
          <div role="alert" className="space-y-1 text-sm text-danger">
            <p>
              You're the only owner of these organizations, and they have other members. Make someone else an owner,
              or delete the organization first:
            </p>
            <ul className="list-disc pl-5">
              {blocking.map((org) => (
                <li key={org.id}>
                  <Link className="underline" to={`/orgs/${org.id}/members`}>
                    {org.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ErrorText error={deleteAccount.error} />
        )}
      </Card>
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npm test -w dashboard && npm run typecheck -w dashboard && npm run lint -w dashboard`
Expected: PASS, including the existing settings tests. The new "Password" label must not collide with "Current password" / "New password", because `getByLabelText` matches whole strings.

- [x] **Step 5: Commit**

```bash
git add dashboard
git commit -m "feat(dashboard): export and delete projects, orgs and accounts"
```

---

### Task 11: Landing site

**Files:**
- Create: `dashboard/src/theme.css`, `site/package.json`, `site/tsconfig.json`, `site/eslint.config.js`, `site/vite.config.ts`, `site/index.html`, `site/beta/index.html`, `site/privacy/index.html`, `site/src/main.css`, `site/src/copy.ts`, `site/src/pages.test.ts`, `site/public/CNAME`, `site/public/favicon.svg`, `.github/workflows/site.yml`
- Modify: `dashboard/src/index.css`, `package.json` (root), `package-lock.json`, `server/Dockerfile`, `docs/releasing.md`

Before starting, get the Backblaze region from the author (see Prerequisites).

- [ ] **Step 1: Share the theme**

Move everything in `dashboard/src/index.css` after the three `@import` lines (the `@theme` block, `@layer base`, and the three `@utility` blocks, with their comments) into a new `dashboard/src/theme.css`. Add a header comment:

```css
/* Tripcord's look, shared by the dashboard and the landing site (site/). Import
   it after tailwindcss and the two @fontsource fonts. */
```

`dashboard/src/index.css` becomes:

```css
@import "tailwindcss";
@import "@fontsource-variable/schibsted-grotesk";
@import "@fontsource-variable/jetbrains-mono";
@import "./theme.css";
```

Run: `npm run build -w dashboard && npm test -w dashboard`
Expected: PASS. Open `npm run dev -w dashboard` once to confirm nothing changed visually.

- [ ] **Step 2: Create the workspace**

Add `"site"` to the root `package.json` `workspaces`.

`site/package.json`:

```json
{
  "name": "@tripcord/site",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@fontsource-variable/jetbrains-mono": "^5.3.0",
    "@fontsource-variable/schibsted-grotesk": "^5.3.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "@types/node": "^22.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "eslint": "^9.0.0",
    "globals": "^17.12.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`site/tsconfig.json`: the dashboard's, minus `jsx`, with `"types": ["vite/client", "node"]`.

`site/eslint.config.js`: the dashboard's, with `files: ["src/**/*.ts"]` and no `jsx` parser option. `pages.test.ts` needs `globals.node` as well as `globals.browser`.

`site/vite.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    rollupOptions: {
      input: { home: page("./index.html"), beta: page("./beta/index.html"), privacy: page("./privacy/index.html") },
    },
  },
});
```

`site/src/main.css`:

```css
@import "tailwindcss";
@import "@fontsource-variable/schibsted-grotesk";
@import "@fontsource-variable/jetbrains-mono";
@import "../../dashboard/src/theme.css";
```

`site/src/copy.ts`:

```ts
// <button data-copy="#snippet"> copies that element's text.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  button.addEventListener("click", async () => {
    const target = document.querySelector(button.dataset.copy ?? "");
    await navigator.clipboard?.writeText(target?.textContent ?? "");
    button.textContent = "Copied";
  });
}
```

`site/public/CNAME` contains the single line `tripcord.dev`.

`site/public/favicon.svg`: the cord-and-knot mark from `Wordmark` in `dashboard/src/components/ui.tsx`, as a standalone SVG. Use literal colors (`#ff7a1a` → `#ffb347` gradient, `#3ddc84` knot) instead of CSS variables.

In `server/Dockerfile`, add `COPY site/package.json site/package.json` after the `dashboard/package.json` line in **both** the `dashboard-build` and `build` stages. Otherwise `npm ci` fails on the new workspace.

Run: `npm install`. It updates `package-lock.json`.

- [ ] **Step 3: Write the failing test**

Create `site/src/pages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
// URL path → source file. Every internal link must land on one of these.
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/beta/": "beta/index.html",
  "/privacy/": "privacy/index.html",
};

function html(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

describe("site pages", () => {
  for (const [url, file] of Object.entries(PAGES)) {
    describe(url, () => {
      const source = html(file);

      it("has a title and a description", () => {
        expect(source).toMatch(/<title>[^<]+<\/title>/);
        expect(source).toMatch(/<meta name="description" content="[^"]+"/);
      });

      it("links only to pages and anchors that exist", () => {
        for (const [, href] of source.matchAll(/href="(\/[^"]*)"/g)) {
          if (href.startsWith("/favicon")) continue;
          const [pathname, anchor] = href.split("#");
          const target = PAGES[pathname];
          expect(target, `${file} links to ${href}`).toBeDefined();
          if (anchor) {
            expect(html(target), `${href} anchor`).toContain(`id="${anchor}"`);
          }
        }
      });

      it("has no placeholders left", () => {
        expect(source).not.toMatch(/TODO|TBD|\[region\]/);
      });

      it("loads no third-party scripts or analytics", () => {
        for (const [, src] of source.matchAll(/<script[^>]*src="([^"]+)"/g)) {
          expect(src.startsWith("/")).toBe(true);
        }
      });
    });
  }

  it("publishes the custom domain", () => {
    expect(existsSync(path.join(ROOT, "public", "CNAME"))).toBe(true);
  });
});
```

Run: `npm test -w site`
Expected: FAIL. The pages don't exist yet.

- [ ] **Step 4: Write the pages**

Every page shares the same `<head>` (charset, viewport, the page's `<title>` and `<meta name="description">`, `<link rel="icon" href="/favicon.svg">`, `<link rel="stylesheet" href="/src/main.css">`), header, footer and `<script type="module" src="/src/copy.ts">`. They're repeated in each file, and there's no templating for three pages. Use the dashboard's classes: `panel`, `bg-cord`, `text-cord`, `text-muted`, `border-border`, `font-mono`. The layout is `max-w-5xl mx-auto px-4`, and it must work at 360px wide with no horizontal scroll.

**Header** (all pages): the wordmark (the same inline SVG as `Wordmark`, plus "Tripcord") linking to `/`. Nav links: "Beta commitments" → `/beta/`, "Self-host" → `https://github.com/jonaszbigda/tripcord/blob/main/docs/self-hosting.md`, "GitHub" → `https://github.com/jonaszbigda/tripcord`. A primary "Request access" button → `mailto:hello@tripcord.dev?subject=Tripcord%20beta%20access`.

**Footer** (all pages): links to GitHub, npm (`https://www.npmjs.com/package/@tripcord/js`), Status (`https://status.tripcord.dev`), Self-hosting guide, Beta commitments (`/beta/`), Privacy (`/privacy/`), and `hello@tripcord.dev`. Then "MIT licensed. Hosted in the EU."

**`site/index.html`**: title "Tripcord: no noise, pure signal". Description: "Tripcord records the moments you choose in your web app, and sends the timeline that led up to an error or any moment you capture." Sections, in order. Copy must stay honest to what's built:

1. **Hero.** `<h1>` "No noise, pure signal." Subhead: "You choose what goes on the timeline. When something breaks, or a moment you care about happens, Tripcord sends the steps that led there." Two questions as small labels: "Why did this break?" / "How did people get here?". Buttons: "Request access" (mailto) and "Self-host it" (the guide).
2. **How it works** (`id="how"`). Three steps:
   1. `npm i @tripcord/js`
   2. `init({ endpoint, apiKey })`
   3. `track("checkout.step", { step: "shipping" })` for the moments that matter, `capture("signup.completed")` to send a timeline on purpose. Errors and unhandled rejections are captured on their own.

   One code block (`<pre id="snippet">`) with the README's quick-start, and a copy button (`data-copy="#snippet"`):

   ```ts
   import { init, track, capture } from "@tripcord/js";

   init({ endpoint: "https://app.tripcord.dev/v1/timeline", apiKey: "tpk_…" });

   track("checkout.step", { step: "shipping" });
   capture("checkout.completed");
   ```
3. **The dashboard.** `<img src="../docs/dashboard.png" alt="The Tripcord dashboard: captures over time, the top reasons, and a list of timelines" loading="lazy">` in a `panel`. Caption: "Captures over time, the top reasons, filters by tag, and every timeline step by step."
4. **Safe for production** (`id="safe"`). Four short points:
   - "Your app comes first: the client never throws and never retries. If Tripcord is down, your users don't notice."
   - "URLs are trimmed to origin and path by default. Query strings and fragments, where tokens hide, are dropped."
   - "Nothing is recorded that you didn't choose, apart from errors."
   - "Timelines are kept for 30 days."
5. **Open source.** "MIT licensed. Run the same image on your own server, or use the hosted beta. Your data isn't locked in either way: export any project as NDJSON, or delete it." Links: the self-hosting guide, `/beta/`.

**`site/beta/index.html`**: title "Beta commitments | Tripcord". Description: "What the Tripcord hosted beta promises: free tier, backups, export, deletion and notice." `<h1>` "What the beta promises". A one-paragraph intro ("Tripcord's hosted beta is free and invite-only. It runs on one server in France. These are the promises we keep while it's a beta, and after."), then these sections, each an `<h2>` with a paragraph, in this order, with exactly this wording:

- **Your app comes first.** The client never throws, never retries, and never blocks your page. If Tripcord is down, your users don't notice.
- **Your data is backed up.** Every night, encrypted, to storage separate from the server, kept for 14 days. Restores are tested. Timelines are kept for 30 days.
- **Deploys never remove data.** Database migrations only move forward. Anything that would drop data gets announced first.
- **There will always be a free tier.** Tripcord is free during the beta. If paid plans come, you get 30 days' notice and a generous free tier. Paid plans add capacity. They never lock you out of data you already have, and export is available on every plan.
- **You can leave at any time.** Export a project's timelines as NDJSON, and delete projects, organizations or your account from the dashboard. Deleted data is gone from the database immediately, and from backups within 14 days. Tripcord is open source, and the hosted version runs the same image you can self-host.
- **The API stays stable.** `/v1/timeline` and `@tripcord/js` 0.x stay backward compatible. A breaking change would get a new endpoint version, and the old one keeps working for at least 6 months.
- **If the service ever shuts down,** you get 60 days' notice, an export, and the self-host path.
- **What "beta" means.** It runs on one server, and there's no uptime SLA. Incidents are posted on the status page (link `https://status.tripcord.dev`).

End with "Questions: hello@tripcord.dev" and a link to `/privacy/`.

**`site/privacy/index.html`**: title "Privacy | Tripcord". Description: "What the Tripcord hosted beta stores, where, for how long, and who processes it." `<h1>` "Privacy". Sections:

- **What's stored.**
  - Your account: email, name, a password hash, and your GitHub user id if you connect GitHub.
  - Timelines: whatever your app records, plus the page URL (origin and path by default) and the browser's user agent.
  - No IP addresses are stored, with timelines or in the server's logs. The server uses them briefly, in memory, to rate-limit requests.
- **Where.** On a server at OVH, in France. Encrypted backups are stored with Backblaze (B2), in **<the region the author gave>**.
- **Who processes it.** OVH (server and email), Backblaze (backups), and GitHub (this website, and GitHub login if you use it).
- **How long.** Timelines 30 days. Accounts until you delete them. Backups 14 days. Deleting data removes it from the database immediately, and from backups within 14 days.
- **What we never do.** Sell data, use it for advertising, or track visitors. This site has no analytics, no cookies and no third-party scripts.
- **Contact.** hello@tripcord.dev, including for a data processing agreement.

- [ ] **Step 5: Run the tests and the build**

Run: `npm test -w site && npm run build -w site && npm run lint -w site && ls site/dist site/dist/beta site/dist/privacy site/dist/assets`
Expected: tests PASS. `dist/` has `index.html`, `beta/index.html`, `privacy/index.html`, `CNAME`, `favicon.svg`, and a hashed `dashboard-*.png` under `assets/`.

If Vite doesn't bundle `../docs/dashboard.png` (it lives outside the site's root), copy it to `site/src/dashboard.png` and reference `./src/dashboard.png` instead. Then drop `docs/dashboard.png` from the workflow's path filter.

Run: `npm run dev -w site`, and check all three pages at 360px and 1280px wide.

- [ ] **Step 6: Deploy workflow**

Create `.github/workflows/site.yml`:

```yaml
name: Site

on:
  push:
    branches: [main]
    paths:
      - "site/**"
      - "dashboard/src/theme.css"
      - "docs/dashboard.png"
      - ".github/workflows/site.yml"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    name: Build tripcord.dev
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test -w site
      - run: npm run build -w site
      - uses: actions/upload-pages-artifact@v4
        with:
          path: site/dist

  deploy:
    name: Deploy to GitHub Pages
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

Before committing, check the latest majors of `actions/upload-pages-artifact` and `actions/deploy-pages` (`gh api repos/actions/deploy-pages/releases/latest --jq .tag_name`), and pin those.

In `docs/releasing.md`, add a "Landing site" section under One-time setup:
- In the repository's Settings → Pages, set Source to GitHub Actions and Custom domain to `tripcord.dev`, then enforce HTTPS.
- DNS: apex `A` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153` and `185.199.111.153` (plus the matching `AAAA` records from GitHub's docs).

Also note that the site deploys on its own whenever `site/**` changes on `main`.

- [ ] **Step 7: Whole-repo check and image build**

Run: `npm run build && npm run typecheck && npm run lint && npm test`, then `docker build -f server/Dockerfile -t tripcord-site-check . && docker image rm tripcord-site-check`
Expected: PASS, and the image builds with the new workspace.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json dashboard/src site server/Dockerfile .github/workflows/site.yml docs/releasing.md
git commit -m "feat(site): landing site with beta commitments and privacy page"
```

---

### Task 12: Backups, deploy files and docs

**Files:**
- Create: `deploy/backup.sh`, `deploy/backup.env.example`
- Modify: `deploy/docker-compose.yml`, `deploy/.env.example`, `docs/self-hosting.md`, `server/README.md`, `docs/superpowers/specs/2026-09-24-tripcord-hosted-beta-design.md`

- [ ] **Step 1: The backup script**

Create `deploy/backup.sh` (and `git update-index --chmod=+x deploy/backup.sh`, since the repo is developed on Windows):

```bash
#!/usr/bin/env bash
# Off-site backup for a Tripcord deploy: pg_dump, then restic to any restic
# repository (S3-compatible storage such as Backblaze B2, SFTP, ...).
# Run it from cron next to docker-compose.yml. See docs/self-hosting.md → Off-site backups.
set -euo pipefail

cd "$(dirname "$0")"
if [ -f backup.env ]; then
  set -a
  # shellcheck source=/dev/null
  . ./backup.env
  set +a
fi
: "${RESTIC_REPOSITORY:?Set RESTIC_REPOSITORY in backup.env}"
: "${RESTIC_PASSWORD:?Set RESTIC_PASSWORD in backup.env}"
KEEP_DAILY="${KEEP_DAILY:-14}"

dump="$(mktemp)"
trap 'rm -f "$dump"' EXIT

# Dump to a file first, so a failed pg_dump can't become a truncated snapshot.
docker compose exec -T postgres pg_dump -U tripcord -Fc tripcord > "$dump"
restic backup --quiet --tag tripcord --stdin --stdin-filename tripcord.dump < "$dump"
restic forget --quiet --tag tripcord --keep-daily "$KEEP_DAILY" --prune

if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$BACKUP_HEARTBEAT_URL" > /dev/null
fi
```

Create `deploy/backup.env.example`:

```bash
# Copy to backup.env next to backup.sh and chmod 600 it. backup.sh reads it.

# Any restic repository. Backblaze B2 through its S3-compatible API:
RESTIC_REPOSITORY=s3:https://s3.<region>.backblazeb2.com/<bucket>
# Encrypts every backup. Keep a copy somewhere other than this server:
# without it, the backups can't be restored.
RESTIC_PASSWORD=
# For B2: an application key limited to the bucket.
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# How many daily backups to keep. Default 14.
# KEEP_DAILY=14
# Pinged after every successful backup, for a heartbeat monitor.
# BACKUP_HEARTBEAT_URL=
```

- [ ] **Step 2: Try it**

Against the local deploy compose, with a local restic repository:

```bash
cd deploy && cp .env.example .env   # set POSTGRES_PASSWORD and PUBLIC_URL=http://localhost:3000
docker compose up -d
export RESTIC_REPOSITORY=/tmp/tripcord-restic RESTIC_PASSWORD=test
restic init
./backup.sh && restic snapshots --tag tripcord
```

Expected: one snapshot holding `/tripcord.dump`. Then run the restore drill from Step 4's docs text against it. Afterwards: `docker compose down -v && rm -rf /tmp/tripcord-restic .env`.

- [ ] **Step 3: Deploy compose**

In `deploy/docker-compose.yml`, add to the `server` service's `environment`:

```yaml
      SMTP_URL: ${SMTP_URL:-}
      EMAIL_FROM: ${EMAIL_FROM:-}
```

To both services:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
```

In `deploy/.env.example`, add a commented block:

```bash
# Email, for password reset and emailed invites. Set both or neither.
# SMTP_URL=smtps://user:password@smtp.example.com:465
# EMAIL_FROM=Tripcord <no-reply@example.com>
```

- [ ] **Step 4: Docs**

In `docs/self-hosting.md`:
- **Email (optional)**, after GitHub login: what it enables (password reset, `invite create --email`), the two variables, the URL encoding needed for special characters in the SMTP password, and that the sending domain needs SPF, DKIM and DMARC records.
- **First account:** after the `SIGNUP` bullets, add signup invites: `docker compose exec server node server/dist/cli.js invite create --email someone@example.com` gives a new user their own org on an `invite-only` instance.
- **Backups:** keep the local `pg_dump` pair. Add "Off-site backups": install restic, copy `backup.env.example` to `backup.env`, run `restic init`, try `./backup.sh`, then the cron line `15 3 * * * /path/to/tripcord/backup.sh >> /var/log/tripcord-backup.log 2>&1`. Keep `RESTIC_PASSWORD` somewhere off the server. Add "Restore drill":

  ```bash
  restic restore latest --tag tripcord --target /tmp/tripcord-restore
  docker run -d --name tripcord-drill -e POSTGRES_PASSWORD=drill postgres:16-alpine
  sleep 5
  docker exec tripcord-drill createdb -U postgres tripcord
  docker exec -i tripcord-drill pg_restore -U postgres -d tripcord --no-owner < /tmp/tripcord-restore/tripcord.dump
  docker exec tripcord-drill psql -U postgres -d tripcord -tc "select count(*) from timelines"
  docker compose exec -T postgres psql -U tripcord -d tripcord -tc "select count(*) from timelines"
  docker rm -f tripcord-drill && rm -rf /tmp/tripcord-restore
  ```

  The two counts should be close; the live one keeps growing after the backup.
- **Logs:** one line. The server writes no client IPs or tokens to its logs, and the compose file rotates them at 50 MB. If you add Caddy access logs, those will contain IPs.

In `server/README.md`, add `SMTP_URL` and `EMAIL_FROM` to the environment table. In the API section, add a paragraph: password reset (`POST /api/auth/password-reset`, `…/confirm`, only with SMTP), the three `DELETE` routes, and `GET …/export`, pointing at the hosted beta spec.

In the hosted beta spec, set `Status: approved`.

- [ ] **Step 5: Commit**

```bash
git add deploy docs server/README.md
git commit -m "docs: off-site backups, email and deletion for self-hosters"
```

---

### Task 13: Version and final check

**Files:**
- Modify: `server/package.json`, `package-lock.json`, `packages/js/README.md` (only if the compatibility table needs a row; the client is unchanged, so it shouldn't)

- [ ] **Step 1: Bump the server**

Set `"version": "0.2.0"` in `server/package.json`, and run `npm install` so the lockfile matches.

- [ ] **Step 2: Whole-repo check**

Run: `npm run build && npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 3: Manual check on a local instance**

With `docker compose up` (root, development), using a local SMTP catcher (e.g. `docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`, `SMTP_URL=smtp://host.docker.internal:1025`, `EMAIL_FROM=Tripcord <no-reply@localhost>`):
1. Bootstrap an account.
2. `invite create --email neo@example.com`. The mail arrives. Sign up through the link, and the new user has their own org.
3. Log out. Use "Forgot password?", follow the emailed link, set a password, and log in with it.
4. Create a project, send a timeline, export it (the NDJSON has one line), then delete the project.
5. Try deleting an account that's the only owner of an org with another member. The org is listed. Then delete an account that isn't.
6. Check the server logs: no IPs, and `tpi_[redacted]` / `tpr_[redacted]` wherever a link was opened.

- [ ] **Step 4: Commit**

```bash
git add server/package.json package-lock.json
git commit -m "chore(server): bump version to 0.2.0"
```

Releasing (tag `server-v0.2.0`) and deploying to `app.tripcord.dev` are the author's call, following `docs/releasing.md` and the private runbook.
