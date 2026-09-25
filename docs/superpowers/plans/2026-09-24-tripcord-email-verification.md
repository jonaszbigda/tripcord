# Email Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Password signups on an instance with `SIGNUP=open` and SMTP must confirm their email by a one-time link before they can use the dashboard.

**Architecture:** A nullable `users.email_verified_at` plus an `email_verifications` token table, built like `password_resets`. A new `email-verification.ts` module owns sending, verifying, changing an unverified address and cleanup. `requireUser` gains the gate, routes opt out with `config: { allowUnverified: true }`. The dashboard swaps the app for a "check your inbox" page while `me.user.emailVerified` is false, and adds a public `/verify-email/:token` page.

**Tech Stack:** TypeScript, Fastify 5, drizzle-orm + drizzle-kit (Postgres), nodemailer, Vitest + Testcontainers (server), React + TanStack Query + React Router + Testing Library (dashboard).

**Spec:** `docs/superpowers/specs/2026-09-24-tripcord-email-verification-design.md`

## Global Constraints

- Verification is active exactly when `SIGNUP=open` **and** SMTP is configured (a mailer exists). No new environment variable.
- Tokens are `tpv_` + 32 random bytes base64url; only the SHA-256 is stored. Tokens never appear in logs.
- Link lifetime 24 hours. Resend cooldown 2 minutes per address. Unverified accounts deleted after 7 days, only while verification is active.
- **Addition to the spec:** at most 5 verification emails per user per 24 hours. Without it, `PATCH /api/me/email` (which sends at once to a new address) could mail arbitrary addresses every few seconds. Throttled requests answer `429 { error, retryAfterSeconds }`.
- Error bodies are `{ "error": "message" }`. Exact messages: `Email not verified` (gate, 403), `Invalid or expired link` (400), `Email already verified` (409 on resend, 403 on change), `Email already registered` (409), `Too many verification emails` (429).
- Plain-text email only. Subject `Confirm your Tripcord email`.
- Server commands run from `server/`, dashboard commands from `dashboard/`. Server tests need Docker (Testcontainers). Run `npm install` at the repo root once before starting.
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` after a blank line.

## Review Focus

1. **Re-entering the current address in "Wrong address?"** (`Ana@Example.com` when the account is `ana@example.com`) must resend to it (or throttle), never answer `409 Email already registered` against the user's own row. Pinned in Task 5.
2. **Opening the link in a browser with no session, or someone else's session,** must verify the token's owner. The route ignores cookies. Pinned in Task 5.
3. **Clicking the link twice** (double click, mail scanner prefetch, StrictMode). The second call answers `400`, but the account stays verified, and the dashboard posts the token only once. Pinned in Task 3 and Task 8.
4. **Switching an instance from `open` back to `invite-only`** while some users are unverified. `me.user.emailVerified` must read `true`, the gate must let them through, and the cleanup must not delete them. Pinned in Task 4 and Task 6.
5. **SMTP failing at signup.** The account is still created (`201`), the failure is logged without the token, and "resend" works afterwards. Pinned in Task 4.

---

## File Structure

**Server**

| File | Change | Responsibility |
|---|---|---|
| `server/src/db/schema.ts` | modify | `users.emailVerifiedAt`, `emailVerifications` table |
| `server/drizzle/0005_email_verification.sql` (+ `meta/`) | create (generated) | Migration, plus backfill of existing users |
| `server/src/db/users.ts` | modify | `emailVerifiedAt` on insert, `setEmail`, `markEmailVerified`, `listUnverifiedUserIds` |
| `server/src/db/email-verifications.ts` | create | Token rows: create, revoke, list recent, consume, delete stale |
| `server/src/email-verification.ts` | create | Activation rule, startup warning, send/verify/change/cleanup logic |
| `server/src/email.ts` | modify | `verifyEmailMail` |
| `server/src/deletion.ts` | modify | Delete a user's `email_verifications` rows |
| `server/src/password-reset.ts` | modify | A consumed reset verifies the email |
| `server/src/accounts.ts` | modify | `SignUpInput.emailVerified` |
| `server/src/auth/http.ts` | modify | `requireUser(db, emailVerification)` gate, `allowUnverified` route config |
| `server/src/routes/context.ts`, `server/src/app.ts` | modify | `ctx.emailVerification` |
| `server/src/routes/me.ts` | modify | `meBody` gains `emailVerified`; resend and change-email routes |
| `server/src/routes/auth.ts` | modify | Config flag, signup sends the link, `POST /api/auth/verify-email` |
| `server/src/routes/github.ts` | modify | GitHub signups start verified |
| `server/src/routes/{invites,orgs,projects,timelines}.ts` | modify | Pass the flag to `requireUser` |
| `server/src/retention.ts`, `server/src/index.ts` | modify | Cleanup steps, startup warning |
| `server/src/redact.ts` | modify | Comment mentions `tpv_` (pattern already covers it) |
| `server/test/db.ts` | modify | `resetDb` clears the new table; `createTestUser` gets `emailVerified` |

**Dashboard**

| File | Change | Responsibility |
|---|---|---|
| `dashboard/src/types.ts`, `dashboard/src/test/fixtures.ts` | modify | `emailVerified`, `emailVerification` fields |
| `dashboard/src/queryClient.ts` | modify | `403 Email not verified` refetches `me` |
| `dashboard/src/components/RequireAuth.tsx` | modify | Renders the pending page for unverified users |
| `dashboard/src/pages/VerifyEmailPendingPage.tsx` | create | "Check your inbox", resend, change address, log out, delete |
| `dashboard/src/pages/VerifyEmailPage.tsx` | create | Public `/verify-email/:token` |
| `dashboard/src/App.tsx` | modify | Route for `VerifyEmailPage` |
| `dashboard/src/pages/verify-email.test.tsx` | create | Tests for both pages and the gate |

**Docs:** `server/README.md`, `docs/self-hosting.md`, `docs/superpowers/specs/2026-09-24-tripcord-hosted-beta-design.md`.

---

### Task 1: Schema, migration and test helpers

**Files:**
- Modify: `server/src/db/schema.ts`
- Create: `server/drizzle/0005_email_verification.sql` (generated, then edited), `server/drizzle/meta/*` (generated)
- Modify: `server/src/db/users.ts`, `server/src/deletion.ts`, `server/test/db.ts`
- Test: `server/src/db/migrations.test.ts`, `server/src/db/users.test.ts`, `server/src/deletion.test.ts`

**Interfaces:**
- Produces: `emailVerifications` table export and `EmailVerification` type from `schema.ts`; `User.emailVerifiedAt: Date | null`.
- Produces in `db/users.ts`: `NewUser.emailVerifiedAt?: Date | null`; `setEmail(ex, userId, email): Promise<void>`; `markEmailVerified(ex, userId, now?: Date): Promise<void>` (only sets it when null); `listUnverifiedUserIds(ex, createdBefore: Date): Promise<string[]>`.
- Produces in `test/db.ts`: `TestUserOptions.emailVerified?: boolean` (default `true`).

- [ ] **Step 1: Write the failing migration test**

Append to `server/src/db/migrations.test.ts`:

```ts
describe("email verification migration (0005)", () => {
  it("marks every existing user verified at their signup time", async () => {
    await withFreshDatabase(async (pool) => {
      const db = drizzle(pool);
      const before = migrationsBefore(5);
      try {
        await migrate(db, { migrationsFolder: before });
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      await pool.query(
        `INSERT INTO users (email, name, created_at) VALUES ('a@example.com', 'A', '2026-09-01 10:00:00'), ('b@example.com', 'B', '2026-09-02 11:00:00')`
      );

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const rows = await pool.query<{ same: boolean }>(`SELECT email_verified_at = created_at AS same FROM users`);
      expect(rows.rows).toEqual([{ same: true }, { same: true }]);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/db/migrations.test.ts -t "0005"`
Expected: FAIL, `column "email_verified_at" does not exist`.

- [ ] **Step 3: Add the schema**

In `server/src/db/schema.ts`, add to `users` after `githubId`:

```ts
  // NULL until the owner opens a verification link. Only enforced while
  // verification is active (SIGNUP=open with SMTP); see email-verification.ts.
  emailVerifiedAt: timestamp("email_verified_at"),
```

After the `passwordResets` table, add:

```ts
export const emailVerifications = pgTable(
  "email_verifications",
  {
    // SHA-256 of the tpv_ token. The token itself only ever travels in the email.
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // The address the link went to: a link only verifies that address.
    email: text("email").notNull(),
    // Set from the server's clock (not defaultNow), as in password_resets, so the
    // cooldown and daily limit compare like with like.
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    // Set when the link is used, or when a newer link or an address change
    // replaces it. Rows stay until the daily cleanup, so they count toward the
    // daily send limit.
    usedAt: timestamp("used_at"),
  },
  (table) => ({
    userIdx: index("email_verifications_user_idx").on(table.userId),
  })
);
```

At the bottom, next to the other type exports, add:

```ts
export type EmailVerification = typeof emailVerifications.$inferSelect;
```

- [ ] **Step 4: Generate the migration and add the backfill**

Run: `npx drizzle-kit generate --name email_verification`

Expected: a new `drizzle/0005_email_verification.sql` and updated `drizzle/meta/_journal.json` and snapshot. The SQL should create `email_verifications` with its foreign key and index, and contain `ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp;`. If drizzle-kit generated anything else (a change to another table), stop: the schema and snapshots disagree.

Append to the end of `drizzle/0005_email_verification.sql`:

```sql
--> statement-breakpoint
-- Everyone who signed up before verification existed came through an invite.
UPDATE "users" SET "email_verified_at" = "created_at";
```

- [ ] **Step 5: Run the migration test**

Run: `npx vitest run src/db/migrations.test.ts`
Expected: PASS (all migration tests).

- [ ] **Step 6: Write failing tests for the user helpers**

Append inside `describe("users", ...)` in `server/src/db/users.test.ts`, and add `markEmailVerified, setEmail, listUnverifiedUserIds` to its import from `./users`:

```ts
  it("stores emailVerifiedAt when given, and NULL by default", async () => {
    const db = getTestDb();
    const at = new Date("2026-09-24T10:00:00Z");
    const verified = await insertUser(db, { email: "v@example.com", name: "V", passwordHash: null, githubId: null, emailVerifiedAt: at });
    const plain = await insertUser(db, { email: "p@example.com", name: "P", passwordHash: null, githubId: null });
    expect(verified.emailVerifiedAt).toEqual(at);
    expect(plain.emailVerifiedAt).toBeNull();
  });

  it("markEmailVerified sets the time once and never moves it", async () => {
    const db = getTestDb();
    const user = await createTestUser(db, { emailVerified: false });
    const first = new Date("2026-09-24T10:00:00Z");
    await markEmailVerified(db, user.id, first);
    await markEmailVerified(db, user.id, new Date("2026-09-25T10:00:00Z"));
    expect((await findUserById(db, user.id))?.emailVerifiedAt).toEqual(first);
  });

  it("setEmail stores the normalized address", async () => {
    const db = getTestDb();
    const user = await createTestUser(db);
    await setEmail(db, user.id, " New@Example.com ");
    expect((await findUserById(db, user.id))?.email).toBe("new@example.com");
  });

  it("lists unverified users created before a cutoff", async () => {
    const db = getTestDb();
    const old = await createTestUser(db, { emailVerified: false });
    const recent = await createTestUser(db, { emailVerified: false });
    await createTestUser(db); // verified
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(users.id, old.id));

    const ids = await listUnverifiedUserIds(db, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

    expect(ids).toEqual([old.id]);
    expect(ids).not.toContain(recent.id);
  });
```

Add to the top of the file: `import { eq } from "drizzle-orm";` and `import { users } from "./schema";`.

- [ ] **Step 7: Run to verify they fail**

Run: `npx vitest run src/db/users.test.ts`
Expected: FAIL, the new functions aren't exported and `emailVerified` isn't a test option.

- [ ] **Step 8: Implement the user helpers**

In `server/src/db/users.ts`, change the import to `import { and, count, eq, isNull, lt } from "drizzle-orm";`, add to `NewUser`:

```ts
  /** NULL (the default) until the owner proves the address. */
  emailVerifiedAt?: Date | null;
```

and append:

```ts
export async function setEmail(ex: Executor, userId: string, email: string): Promise<void> {
  await ex.update(users).set({ email: normalizeEmail(email) }).where(eq(users.id, userId));
}

/** Records the first verification; later calls keep the original time. */
export async function markEmailVerified(ex: Executor, userId: string, now = new Date()): Promise<void> {
  await ex
    .update(users)
    .set({ emailVerifiedAt: now })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
}

export async function listUnverifiedUserIds(ex: Executor, createdBefore: Date): Promise<string[]> {
  const rows = await ex
    .select({ id: users.id })
    .from(users)
    .where(and(isNull(users.emailVerifiedAt), lt(users.createdAt, createdBefore)));
  return rows.map((row) => row.id);
}
```

- [ ] **Step 9: Update the test helpers**

In `server/test/db.ts`, add `emailVerifications` to the schema import, and in `resetDb` insert this line right after `await db.delete(passwordResets);`:

```ts
  await db.delete(emailVerifications);
```

Add to `TestUserOptions`:

```ts
  /** Default true: most tests are about something else, and the gate is only on with SIGNUP=open and a mailer. */
  emailVerified?: boolean;
```

and in `createTestUser`'s `insertUser` call add:

```ts
    emailVerifiedAt: options.emailVerified === false ? null : new Date(),
```

- [ ] **Step 10: Run the user tests**

Run: `npx vitest run src/db/users.test.ts`
Expected: PASS.

- [ ] **Step 11: Write the failing deletion test**

Append to `server/src/deletion.test.ts` inside the `deleteUser` describe block (add imports `emailVerifications` from `./db/schema` and `eq` from `drizzle-orm` if missing):

```ts
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
```

- [ ] **Step 12: Run to verify it fails**

Run: `npx vitest run src/deletion.test.ts -t "email verification links"`
Expected: FAIL with a foreign key violation on `email_verifications_user_id_users_id_fk`.

- [ ] **Step 13: Delete the rows in `deleteUser`**

In `server/src/deletion.ts`, add `emailVerifications` to the schema import, and after `await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));` add:

```ts
    await tx.delete(emailVerifications).where(eq(emailVerifications.userId, userId));
```

- [ ] **Step 14: Run the server suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. Existing tests are unaffected because the new column is nullable and nothing reads it yet.

- [ ] **Step 15: Commit**

```bash
git add server/src/db/schema.ts server/drizzle server/src/db/users.ts server/src/db/users.test.ts server/src/deletion.ts server/src/deletion.test.ts server/src/db/migrations.test.ts server/test/db.ts
git commit -m "feat(server): email verification schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Verification email message

**Files:**
- Modify: `server/src/email.ts`, `server/src/redact.ts`
- Test: `server/src/email.test.ts`, `server/src/redact.test.ts`

**Interfaces:**
- Produces: `verifyEmailMail(to: string, name: string, link: string): Mail`.

- [ ] **Step 1: Write the failing tests**

In `server/src/email.test.ts`, add `verifyEmailMail` to the import and append inside `describe("messages", ...)`:

```ts
  it("email verification: the link, its expiry, and what happens if unexpected", () => {
    const mail = verifyEmailMail("ana@example.com", "Ana", "https://app.tripcord.dev/verify-email/tpv_x");
    expect(mail.to).toBe("ana@example.com");
    expect(mail.subject).toBe("Confirm your Tripcord email");
    expect(mail.text).toContain("Hi Ana,");
    expect(mail.text).toContain("https://app.tripcord.dev/verify-email/tpv_x");
    expect(mail.text).toContain("24 hours");
    expect(mail.text).toContain("deleted in 7 days");
  });
```

In `server/src/redact.test.ts`, add to the existing redaction test:

```ts
    expect(redactTokens("/verify-email/tpv_abc")).toBe("/verify-email/tpv_[redacted]");
```

- [ ] **Step 2: Run to verify the email test fails**

Run: `npx vitest run src/email.test.ts src/redact.test.ts`
Expected: email test FAILS (`verifyEmailMail` is not exported); redact test PASSES already, since the pattern covers every `tp?_` prefix.

- [ ] **Step 3: Implement**

Append to `server/src/email.ts`:

```ts
export function verifyEmailMail(to: string, name: string, link: string): Mail {
  return {
    to,
    subject: "Confirm your Tripcord email",
    text: [
      `Hi ${name},`,
      "",
      "To finish signing up for Tripcord, confirm your email address:",
      "",
      link,
      "",
      "This link expires in 24 hours. If you didn't sign up for Tripcord, ignore this",
      "email and the account will be deleted in 7 days.",
    ].join("\n"),
  };
}
```

In `server/src/redact.ts`, change the first comment line to:

```ts
// Invite (tpi_), password-reset (tpr_) and email-verification (tpv_) tokens
// travel in URLs, and a leaked log line must not be a working link. API keys
// (tpk_) never should, but are covered by the same pattern.
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/email.test.ts src/redact.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/email.ts server/src/email.test.ts server/src/redact.ts server/src/redact.test.ts
git commit -m "feat(server): email verification message

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Verification module

**Files:**
- Create: `server/src/db/email-verifications.ts`, `server/src/email-verification.ts`
- Modify: `server/src/password-reset.ts`
- Test: `server/src/email-verification.test.ts` (create), `server/src/password-reset.test.ts`

**Interfaces:**
- Consumes (Task 1): `setEmail`, `markEmailVerified`, `listUnverifiedUserIds`, `findUserById`, `findUserByEmail`, `normalizeEmail` from `db/users.ts`; `deleteUser` from `deletion.ts`. (Task 2): `verifyEmailMail`.
- Produces in `db/email-verifications.ts`: `EMAIL_VERIFICATION_TTL_MS`; `createEmailVerification(ex, userId, email, now?): Promise<string>`; `revokeEmailVerifications(ex, userId, now?): Promise<void>`; `recentEmailVerifications(ex, userId, since): Promise<{ email: string; createdAt: Date }[]>` (newest first); `consumeEmailVerification(ex, token): Promise<{ userId: string; email: string } | undefined>`; `deleteStaleEmailVerifications(ex): Promise<number>`.
- Produces in `email-verification.ts`:
  - `EMAIL_VERIFICATION_COOLDOWN_MS`, `EMAIL_VERIFICATION_DAILY_LIMIT`, `UNVERIFIED_ACCOUNT_TTL_MS`
  - `isEmailVerificationActive(signup: SignupMode, hasMailer: boolean): boolean`
  - `emailVerificationWarning(signup: SignupMode, hasMailer: boolean): string | undefined`
  - `type SendResult = { status: "sent" } | { status: "already_verified" } | { status: "throttled"; retryAfterSeconds: number }`
  - `sendVerification(db, mailer, publicUrl, user: User, now?): Promise<SendResult>`
  - `verifyEmail(db, token): Promise<boolean>`
  - `type ChangeEmailResult = SendResult | { status: "email_taken" }`
  - `changeUnverifiedEmail(db, mailer, publicUrl, user: User, email: string, now?): Promise<ChangeEmailResult>`
  - `deleteUnverifiedAccounts(db, now?): Promise<{ deleted: number; skipped: string[] }>`

- [ ] **Step 1: Write the failing module tests**

Create `server/src/email-verification.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestUser, getTestDb, resetDb } from "../test/db";
import { FakeMailer } from "../test/mailer";
import { deleteStaleEmailVerifications } from "./db/email-verifications";
import { createOrgWithOwner, addMember } from "./db/orgs";
import { emailVerifications, users } from "./db/schema";
import { findUserById } from "./db/users";
import {
  changeUnverifiedEmail,
  deleteUnverifiedAccounts,
  emailVerificationWarning,
  isEmailVerificationActive,
  sendVerification,
  verifyEmail,
} from "./email-verification";

const PUBLIC_URL = "https://app.tripcord.dev";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

function tokenFrom(mailer: FakeMailer, index = 0): string {
  const match = mailer.sent[index].text.match(/\/verify-email\/(tpv_[A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no verification link in the email");
  return match[1];
}

async function reload(id: string) {
  const user = await findUserById(getTestDb(), id);
  if (!user) throw new Error("user is gone");
  return user;
}

describe("activation", () => {
  it("is active only with open signup and a mailer", () => {
    expect(isEmailVerificationActive("open", true)).toBe(true);
    expect(isEmailVerificationActive("open", false)).toBe(false);
    expect(isEmailVerificationActive("invite-only", true)).toBe(false);
    expect(isEmailVerificationActive("invite-only", false)).toBe(false);
  });

  it("warns only for open signup without a mailer", () => {
    expect(emailVerificationWarning("open", false)).toBe(
      "SIGNUP=open without SMTP: signup emails are not verified and password reset is unavailable. Set SMTP_URL and EMAIL_FROM to enable both."
    );
    expect(emailVerificationWarning("open", true)).toBeUndefined();
    expect(emailVerificationWarning("invite-only", false)).toBeUndefined();
  });
});

describe("sendVerification and verifyEmail", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("emails a 24-hour link that verifies the account once", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", name: "Ana", emailVerified: false });
    const mailer = new FakeMailer();

    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user)).toEqual({ status: "sent" });

    expect(mailer.sent[0].to).toBe("ana@example.com");
    const token = tokenFrom(mailer);
    expect(token).toMatch(/^tpv_[A-Za-z0-9_-]{43}$/);
    const [row] = await getTestDb().select().from(emailVerifications).where(eq(emailVerifications.userId, user.id));
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(DAY);
    expect(row.email).toBe("ana@example.com");

    expect(await verifyEmail(getTestDb(), token)).toBe(true);
    expect((await reload(user.id)).emailVerifiedAt).not.toBeNull();
    // Review focus 3: a second click fails but leaves the account verified.
    expect(await verifyEmail(getTestDb(), token)).toBe(false);
    expect((await reload(user.id)).emailVerifiedAt).not.toBeNull();
  });

  it("does nothing for a verified user", async () => {
    const user = await createTestUser(getTestDb());
    const mailer = new FakeMailer();
    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user)).toEqual({ status: "already_verified" });
    expect(mailer.sent).toEqual([]);
  });

  it("rejects unknown and expired tokens", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(Date.now() - DAY - MINUTE));

    expect(await verifyEmail(getTestDb(), tokenFrom(mailer))).toBe(false);
    expect(await verifyEmail(getTestDb(), "tpv_unknown")).toBe(false);
    expect((await reload(user.id)).emailVerifiedAt).toBeNull();
  });

  it("allows one link per address per two minutes, and a new link replaces the old one", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    const start = new Date();

    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, start);
    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + 30_000))).toEqual({
      status: "throttled",
      retryAfterSeconds: 90,
    });
    expect(await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + 3 * MINUTE))).toEqual({
      status: "sent",
    });

    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 0))).toBe(false);
    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 1))).toBe(true);
  });

  it("sends at most five links per user per day", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    const start = new Date();
    for (let i = 0; i < 5; i += 1) {
      const result = await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + i * 3 * MINUTE));
      expect(result).toEqual({ status: "sent" });
    }

    const sixth = await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(start.getTime() + 15 * MINUTE));

    // The first of the five ages out of the 24-hour window at start + 1 day.
    expect(sixth).toEqual({ status: "throttled", retryAfterSeconds: (DAY - 15 * MINUTE) / 1000 });
    expect(mailer.sent).toHaveLength(5);
  });
});

describe("changeUnverifiedEmail", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("changes the address, sends a new link at once, and kills links to the old one", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@exmaple.com", emailVerified: false });
    const mailer = new FakeMailer();
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user);

    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, " Ana@Example.com ")).toEqual({ status: "sent" });

    expect((await reload(user.id)).email).toBe("ana@example.com");
    expect(mailer.sent[1].to).toBe("ana@example.com");
    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 0))).toBe(false);
    expect(await verifyEmail(getTestDb(), tokenFrom(mailer, 1))).toBe(true);
  });

  it("refuses an address another account has", async () => {
    await createTestUser(getTestDb(), { email: "taken@example.com" });
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();

    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, "Taken@example.com")).toEqual({ status: "email_taken" });
    expect(mailer.sent).toEqual([]);
  });

  it("treats the user's own address, in any case, as a resend", async () => {
    const user = await createTestUser(getTestDb(), { email: "ana@example.com", emailVerified: false });
    const mailer = new FakeMailer();

    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, "ANA@example.com")).toEqual({ status: "sent" });
    expect(await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, "ana@example.com")).toMatchObject({
      status: "throttled",
    });
  });

  it("refuses a verified user", async () => {
    const user = await createTestUser(getTestDb());
    expect(await changeUnverifiedEmail(getTestDb(), new FakeMailer(), PUBLIC_URL, user, "new@example.com")).toEqual({
      status: "already_verified",
    });
    expect((await reload(user.id)).email).toBe(user.email);
  });

  it("is throttled by the daily limit before changing anything", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    const start = new Date();
    for (let i = 0; i < 5; i += 1) {
      await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, user, `try${i}@example.com`, new Date(start.getTime() + i * 1000));
    }
    const before = (await reload(user.id)).email;

    const result = await changeUnverifiedEmail(getTestDb(), mailer, PUBLIC_URL, await reload(user.id), "last@example.com", new Date(start.getTime() + 10_000));

    expect(result).toMatchObject({ status: "throttled" });
    expect((await reload(user.id)).email).toBe(before);
  });
});

describe("cleanup", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("deletes accounts unverified for 7 days, with their own org, and keeps the rest", async () => {
    const db = getTestDb();
    const stale = await createTestUser(db, { emailVerified: false });
    await createOrgWithOwner(db, stale.id, "Stale's org");
    const fresh = await createTestUser(db, { emailVerified: false });
    const verified = await createTestUser(db);
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(users.id, verified.id));
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(users.id, stale.id));

    expect(await deleteUnverifiedAccounts(db)).toEqual({ deleted: 1, skipped: [] });

    expect(await findUserById(db, stale.id)).toBeUndefined();
    expect(await findUserById(db, fresh.id)).toBeDefined();
    expect(await findUserById(db, verified.id)).toBeDefined();
  });

  it("skips an account deleteUser refuses", async () => {
    const db = getTestDb();
    const stale = await createTestUser(db, { emailVerified: false });
    const org = await createOrgWithOwner(db, stale.id, "Shared");
    await addMember(db, org.id, (await createTestUser(db)).id, "member");
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(users.id, stale.id));

    expect(await deleteUnverifiedAccounts(db)).toEqual({ deleted: 0, skipped: [stale.id] });
  });

  it("drops links that expired more than a day ago", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const mailer = new FakeMailer();
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user, new Date(Date.now() - 3 * DAY));
    await sendVerification(getTestDb(), mailer, PUBLIC_URL, user);

    expect(await deleteStaleEmailVerifications(getTestDb())).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/email-verification.test.ts`
Expected: FAIL, `Cannot find module './email-verification'`.

- [ ] **Step 3: Implement the data access**

Create `server/src/db/email-verifications.ts`:

```ts
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { Executor } from "./client";
import { emailVerifications } from "./schema";
import { generateToken, hashToken } from "../auth/tokens";

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** A new link for `email`. The user's earlier links stop working. */
export async function createEmailVerification(ex: Executor, userId: string, email: string, now = new Date()): Promise<string> {
  const { token, hash } = generateToken("tpv_");
  await revokeEmailVerifications(ex, userId, now);
  await ex.insert(emailVerifications).values({
    tokenHash: hash,
    userId,
    email,
    createdAt: now,
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
  });
  return token;
}

/** Makes the user's unused links unusable. The rows stay, for the daily limit. */
export async function revokeEmailVerifications(ex: Executor, userId: string, now = new Date()): Promise<void> {
  await ex
    .update(emailVerifications)
    .set({ usedAt: now })
    .where(and(eq(emailVerifications.userId, userId), isNull(emailVerifications.usedAt)));
}

/** The user's links created after `since`, newest first. */
export async function recentEmailVerifications(
  ex: Executor,
  userId: string,
  since: Date
): Promise<{ email: string; createdAt: Date }[]> {
  return ex
    .select({ email: emailVerifications.email, createdAt: emailVerifications.createdAt })
    .from(emailVerifications)
    .where(and(eq(emailVerifications.userId, userId), gt(emailVerifications.createdAt, since)))
    .orderBy(desc(emailVerifications.createdAt));
}

// Conditional update, like consumePasswordReset: of two concurrent uses of one
// token, only the first finds used_at NULL.
/** The token's user and address, marking it used; undefined for an unknown, expired or used token. */
export async function consumeEmailVerification(
  ex: Executor,
  token: string
): Promise<{ userId: string; email: string } | undefined> {
  const [row] = await ex
    .update(emailVerifications)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerifications.tokenHash, hashToken(token)),
        isNull(emailVerifications.usedAt),
        gt(emailVerifications.expiresAt, new Date())
      )
    )
    .returning({ userId: emailVerifications.userId, email: emailVerifications.email });
  return row;
}

/** Links that expired more than a day ago: past the daily limit's window too. */
export async function deleteStaleEmailVerifications(ex: Executor): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await ex
    .delete(emailVerifications)
    .where(lt(emailVerifications.expiresAt, cutoff))
    .returning({ tokenHash: emailVerifications.tokenHash });
  return deleted.length;
}
```

- [ ] **Step 4: Implement the module**

Create `server/src/email-verification.ts`:

```ts
import type { SignupMode } from "./accounts";
import type { Database, Executor } from "./db/client";
import type { User } from "./db/schema";
import {
  consumeEmailVerification,
  createEmailVerification,
  recentEmailVerifications,
  revokeEmailVerifications,
} from "./db/email-verifications";
import { findUserByEmail, findUserById, listUnverifiedUserIds, markEmailVerified, normalizeEmail, setEmail } from "./db/users";
import { deleteUser } from "./deletion";
import { verifyEmailMail, type Mailer } from "./email";

export const EMAIL_VERIFICATION_COOLDOWN_MS = 2 * 60 * 1000;
export const EMAIL_VERIFICATION_DAILY_LIMIT = 5;
export const UNVERIFIED_ACCOUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Open signup is the only way in that doesn't vouch for the address, and
// without SMTP there's no way to check it.
export function isEmailVerificationActive(signup: SignupMode, hasMailer: boolean): boolean {
  return signup === "open" && hasMailer;
}

export function emailVerificationWarning(signup: SignupMode, hasMailer: boolean): string | undefined {
  if (signup === "open" && !hasMailer) {
    return "SIGNUP=open without SMTP: signup emails are not verified and password reset is unavailable. Set SMTP_URL and EMAIL_FROM to enable both.";
  }
  return undefined;
}

export type SendResult =
  | { status: "sent" }
  | { status: "already_verified" }
  | { status: "throttled"; retryAfterSeconds: number };

export type ChangeEmailResult = SendResult | { status: "email_taken" };

// Two limits: one link per address per cooldown, and a daily cap per user, so
// changing the address can't be used to mail strangers.
async function throttleSeconds(ex: Executor, userId: string, email: string, now: Date): Promise<number> {
  const recent = await recentEmailVerifications(ex, userId, new Date(now.getTime() - DAY_MS));
  const waits = [0];
  const lastToEmail = recent.find((row) => row.email === email);
  if (lastToEmail) {
    waits.push(lastToEmail.createdAt.getTime() + EMAIL_VERIFICATION_COOLDOWN_MS - now.getTime());
  }
  if (recent.length >= EMAIL_VERIFICATION_DAILY_LIMIT) {
    // Newest first: once this one leaves the window, there's room for one more.
    const oldestCounted = recent[EMAIL_VERIFICATION_DAILY_LIMIT - 1];
    waits.push(oldestCounted.createdAt.getTime() + DAY_MS - now.getTime());
  }
  return Math.ceil(Math.max(...waits) / 1000);
}

/** Emails `user` a new link. Throws if the mailer does; the link is created first. */
export async function sendVerification(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  user: User,
  now = new Date()
): Promise<SendResult> {
  if (user.emailVerifiedAt !== null) {
    return { status: "already_verified" };
  }
  const wait = await throttleSeconds(db, user.id, user.email, now);
  if (wait > 0) {
    return { status: "throttled", retryAfterSeconds: wait };
  }
  const token = await createEmailVerification(db, user.id, user.email, now);
  await mailer.send(verifyEmailMail(user.email, user.name, `${publicUrl}/verify-email/${token}`));
  return { status: "sent" };
}

/** Verifies the token's user. False for an unknown, expired or used token, or one sent to an old address. */
export async function verifyEmail(db: Database, token: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const consumed = await consumeEmailVerification(tx, token);
    if (!consumed) {
      return false;
    }
    const user = await findUserById(tx, consumed.userId);
    if (!user || user.email !== consumed.email) {
      return false;
    }
    await markEmailVerified(tx, user.id);
    return true;
  });
}

/** Fixes a typo'd address before verification, then sends a link to it. */
export async function changeUnverifiedEmail(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  user: User,
  email: string,
  now = new Date()
): Promise<ChangeEmailResult> {
  if (user.emailVerifiedAt !== null) {
    return { status: "already_verified" };
  }
  const normalized = normalizeEmail(email);
  if (normalized === user.email) {
    return sendVerification(db, mailer, publicUrl, user, now);
  }
  const owner = await findUserByEmail(db, normalized);
  if (owner) {
    return { status: "email_taken" };
  }
  // Checked before changing anything, so a throttled request leaves the address alone.
  const wait = await throttleSeconds(db, user.id, normalized, now);
  if (wait > 0) {
    return { status: "throttled", retryAfterSeconds: wait };
  }
  await db.transaction(async (tx) => {
    await setEmail(tx, user.id, normalized);
    await revokeEmailVerifications(tx, user.id, now);
  });
  return sendVerification(db, mailer, publicUrl, { ...user, email: normalized }, now);
}

/** Deletes accounts left unverified for 7 days. `skipped` holds the ones deleteUser refused. */
export async function deleteUnverifiedAccounts(db: Database, now = new Date()): Promise<{ deleted: number; skipped: string[] }> {
  const ids = await listUnverifiedUserIds(db, new Date(now.getTime() - UNVERIFIED_ACCOUNT_TTL_MS));
  let deleted = 0;
  const skipped: string[] = [];
  for (const id of ids) {
    const result = await deleteUser(db, id);
    if (result.ok) {
      deleted += 1;
    } else {
      skipped.push(id);
    }
  }
  return { deleted, skipped };
}
```

- [ ] **Step 5: Run the module tests**

Run: `npx vitest run src/email-verification.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing password-reset test**

Append inside the `describe` block for `resetPassword` in `server/src/password-reset.test.ts` (or at the end of the file in a new `describe("resetPassword", ...)` with the same `beforeEach`), and add `createPasswordReset` and `findUserById` to the imports if they're not already there:

```ts
  it("verifies the email: the link proves the inbox is theirs", async () => {
    const user = await createTestUser(getTestDb(), { emailVerified: false });
    const token = await createPasswordReset(getTestDb(), user.id);

    expect(await resetPassword(getTestDb(), token, "hash")).toBe(true);

    expect((await findUserById(getTestDb(), user.id))?.emailVerifiedAt).not.toBeNull();
  });
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run src/password-reset.test.ts -t "verifies the email"`
Expected: FAIL, `emailVerifiedAt` is null.

- [ ] **Step 8: Verify in `resetPassword`**

In `server/src/password-reset.ts`, change the users import to `import { findUserByEmail, markEmailVerified, setPasswordHash } from "./db/users";` and in `resetPassword`, after `await setPasswordHash(tx, userId, passwordHash);` add:

```ts
    // The reset link reached this inbox, which is what verification proves.
    await markEmailVerified(tx, userId);
```

- [ ] **Step 9: Run the tests and typecheck**

Run: `npx vitest run src/password-reset.test.ts src/email-verification.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/src/db/email-verifications.ts server/src/email-verification.ts server/src/email-verification.test.ts server/src/password-reset.ts server/src/password-reset.test.ts
git commit -m "feat(server): send, verify and change unverified email addresses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The gate, `me`, config and signup

**Files:**
- Modify: `server/src/auth/http.ts`, `server/src/routes/context.ts`, `server/src/app.ts`, `server/src/accounts.ts`, `server/src/routes/me.ts`, `server/src/routes/auth.ts`, `server/src/routes/github.ts`, `server/src/routes/invites.ts`, `server/src/routes/orgs.ts`, `server/src/routes/projects.ts`, `server/src/routes/timelines.ts`
- Test: `server/src/routes/email-verification.test.ts` (create), `server/src/routes/github.test.ts`

**Interfaces:**
- Consumes (Task 3): `isEmailVerificationActive`, `sendVerification`.
- Produces: `ApiContext.emailVerification: boolean`; `requireUser(db: Database, emailVerification: boolean)`; route option `config: { allowUnverified: true }`; `meBody(db, user, emailVerification: boolean)` whose `user.emailVerified` is `!emailVerification || user.emailVerifiedAt !== null`; `GET /api/auth/config` field `emailVerification`; `SignUpInput.emailVerified?: boolean` (default false).

- [ ] **Step 1: Write the failing route tests**

Create `server/src/routes/email-verification.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestUser, getTestDb, resetDb, sessionCookie } from "../../test/db";
import { buildTestApp, call } from "../../test/http";
import { FakeMailer } from "../../test/mailer";
import { findUserByEmail } from "../db/users";

const ACTIVE = { signup: "open" as const };

async function unverifiedSession() {
  const user = await createTestUser(getTestDb(), { email: "ana@example.com", password: "long-password", emailVerified: false });
  return { user, cookie: await sessionCookie(getTestDb(), user.id) };
}

describe("email verification gate", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("answers 403 on gated routes and lets the allowlist through", async () => {
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const { cookie } = await unverifiedSession();

    const orgs = await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } });
    expect(orgs.statusCode).toBe(403);
    expect(orgs.json()).toEqual({ error: "Email not verified" });

    const me = await call(app, "GET", "/api/me", { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.emailVerified).toBe(false);
  });

  it("is off with invite-only signup, and me says verified (review focus 4)", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "invite-only", mailer: new FakeMailer() });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } })).statusCode).toBe(201);
    expect((await call(app, "GET", "/api/me", { cookie })).json().user.emailVerified).toBe(true);
  });

  it("is off with open signup but no SMTP", async () => {
    const app = await buildTestApp(getTestDb(), ACTIVE);
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } })).statusCode).toBe(201);
  });

  it("reports whether verification is on in /api/auth/config", async () => {
    const on = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const off = await buildTestApp(getTestDb(), ACTIVE);
    expect((await call(on, "GET", "/api/auth/config")).json().emailVerification).toBe(true);
    expect((await call(off, "GET", "/api/auth/config")).json().emailVerification).toBe(false);
  });
});

describe("password signup with verification", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("creates an unverified account and emails a link", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });

    const response = await call(app, "POST", "/api/auth/signup", {
      body: { email: "ana@example.com", name: "Ana", password: "long-password" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user.emailVerified).toBe(false);
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(1));
    expect(mailer.sent[0].text).toContain("/verify-email/tpv_");
  });

  it("still creates the account when SMTP fails (review focus 5)", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("SMTP down")) };
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: failing });

    const response = await call(app, "POST", "/api/auth/signup", {
      body: { email: "ana@example.com", name: "Ana", password: "long-password" },
    });

    expect(response.statusCode).toBe(201);
    await vi.waitFor(() => expect(failing.send).toHaveBeenCalledOnce());
    expect(await findUserByEmail(getTestDb(), "ana@example.com")).toBeDefined();
  });

  it("creates a verified account when verification is off", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "open" });

    await call(app, "POST", "/api/auth/signup", { body: { email: "ana@example.com", name: "Ana", password: "long-password" } });

    expect((await findUserByEmail(getTestDb(), "ana@example.com"))?.emailVerifiedAt).not.toBeNull();
  });
});
```

In `server/src/routes/github.test.ts`, find the test that signs a new user up through GitHub with `{ signup: "open" }` (around line 77). After its existing assertions, add:

```ts
    expect((await findUserByGithubId(getTestDb(), String(ANA.id)))?.emailVerifiedAt).not.toBeNull();
```

Import `findUserByGithubId` from `../db/users` if the file doesn't already. (`ANA.id` is the number `42`; GitHub ids are stored as text.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/email-verification.test.ts src/routes/github.test.ts`
Expected: FAIL. `POST /api/orgs` answers 201 for the unverified user, `emailVerified` is undefined, and the GitHub user has `emailVerifiedAt` null.

- [ ] **Step 3: Add the flag to the context**

In `server/src/routes/context.ts`, add to `ApiContext`:

```ts
  /** SIGNUP=open with SMTP: password signups must verify their email. */
  emailVerification: boolean;
```

In `server/src/app.ts`, import `isEmailVerificationActive` from `./email-verification`, and replace the `const ctx: ApiContext = { ... }` block with:

```ts
  const signup = options.signup ?? "invite-only";
  const ctx: ApiContext = {
    db,
    publicUrl,
    secureCookies: publicUrl.startsWith("https:"),
    signup,
    github: options.github,
    githubFetch: options.githubFetch ?? fetch,
    authRateLimitMax: options.authRateLimitMax ?? 10,
    mailer: options.mailer,
    emailVerification: isEmailVerificationActive(signup, options.mailer !== undefined),
  };
```

- [ ] **Step 4: Add the gate to `requireUser`**

In `server/src/auth/http.ts`, extend the `declare module "fastify"` block with:

```ts
  interface FastifyContextConfig {
    /** Lets an unverified user through requireUser: the routes they need to verify or leave. */
    allowUnverified?: boolean;
  }
```

and replace `requireUser` with:

```ts
export function requireUser(db: Database, emailVerification: boolean) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    const user = token ? await findSessionUser(db, token) : undefined;
    if (!token || !user) {
      return reply.code(401).send({ error: "Not logged in" });
    }
    if (emailVerification && user.emailVerifiedAt === null && !request.routeOptions.config.allowUnverified) {
      return reply.code(403).send({ error: "Email not verified" });
    }
    request.user = user;
    request.sessionToken = token;
  };
}
```

- [ ] **Step 5: Pass the flag at every call site**

Run: `sed -i 's/requireUser(db)/requireUser(db, ctx.emailVerification)/g' src/routes/invites.ts src/routes/me.ts src/routes/orgs.ts src/routes/projects.ts src/routes/timelines.ts`

Then run: `grep -rn "requireUser(db)" src`
Expected: no output.

- [ ] **Step 6: Mark the allowlisted routes and add `emailVerified` to `me`**

In `server/src/routes/me.ts`:

Change `MeBody` and `meBody` to:

```ts
export interface MeBody {
  user: {
    id: string;
    email: string;
    name: string;
    hasPassword: boolean;
    githubConnected: boolean;
    /** False only while verification is active and the user hasn't verified. */
    emailVerified: boolean;
  };
  orgs: UserOrg[];
}

// Also the response body of signup and login, so the SPA can seed its cache.
export async function meBody(db: Database, user: User, emailVerification: boolean): Promise<MeBody> {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      hasPassword: user.passwordHash !== null,
      githubConnected: user.githubId !== null,
      emailVerified: !emailVerification || user.emailVerifiedAt !== null,
    },
    orgs: await listUserOrgs(db, user.id),
  };
}
```

Change the `GET /api/me` route to:

```ts
  app.get(
    "/api/me",
    { preValidation: requireUser(db, ctx.emailVerification), config: { allowUnverified: true } },
    async (request) => meBody(db, currentUser(request), ctx.emailVerification)
  );
```

In the `DELETE /api/me` route options, change `config: { rateLimit: authRateLimit(ctx) }` to:

```ts
      config: { rateLimit: authRateLimit(ctx), allowUnverified: true },
```

In `server/src/routes/auth.ts`, change both `meBody(db, ...)` calls to pass `ctx.emailVerification` as the third argument.

- [ ] **Step 7: Signup sets or sends verification**

In `server/src/accounts.ts`, add to `SignUpInput`:

```ts
  /** True when the address is already proven (GitHub) or doesn't need to be. Default false. */
  emailVerified?: boolean;
```

and in `signUp`'s `insertUser` call add:

```ts
        emailVerifiedAt: input.emailVerified ? new Date() : null,
```

In `server/src/routes/auth.ts`, import `sendVerification` from `../email-verification`, add `emailVerification: ctx.emailVerification,` to the `/api/auth/config` response object, and change the signup handler's `signUp` call and tail to:

```ts
      const result = await signUp(db, {
        email,
        name,
        passwordHash: await hashPassword(request.body.password),
        githubId: null,
        inviteToken: request.body.inviteToken,
        mode: ctx.signup,
        emailVerified: !ctx.emailVerification,
      });
      if (!result.ok) {
        const [status, message] = SIGNUP_ERRORS[result.reason];
        return reply.code(status).send({ error: message });
      }

      await startSession(db, reply, result.user.id, ctx.secureCookies);
      if (ctx.emailVerification && ctx.mailer) {
        // Not awaited: a slow or failing SMTP server mustn't fail the signup.
        // The user can resend from the "check your inbox" page.
        void sendVerification(db, ctx.mailer, ctx.publicUrl, result.user).catch((error: unknown) => {
          request.log.error({ err: error, userId: result.user.id }, "verification email failed");
        });
      }
      return reply.code(201).send(await meBody(db, result.user, ctx.emailVerification));
```

In `server/src/routes/github.ts`, add `emailVerified: true,` to the `signUp` call in `login` (GitHub only returns verified addresses).

- [ ] **Step 8: Run the tests**

Run: `npx vitest run src/routes/email-verification.test.ts src/routes/github.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full server suite and typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. If an existing test compares a whole `/api/me` or signup body with `toEqual`, add `emailVerified: true` to its expected `user` object; don't change anything else in it.

- [ ] **Step 10: Commit**

```bash
git add server/src
git commit -m "feat(server): gate unverified accounts on open instances

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Verify, resend and change-email routes

**Files:**
- Modify: `server/src/routes/auth.ts`, `server/src/routes/me.ts`
- Test: `server/src/routes/email-verification.test.ts`

**Interfaces:**
- Consumes (Task 3): `verifyEmail`, `sendVerification`, `changeUnverifiedEmail`, `SendResult`, `ChangeEmailResult`. (Task 4): `requireUser(db, flag)`, `allowUnverified`, `EMAIL_PATTERN`, `authRateLimit`.
- Produces: `POST /api/auth/verify-email {token}` → 204 | 400 | 404; `POST /api/me/verify-email/resend` → 204 | 409 | 429 `{ error, retryAfterSeconds }` | 404; `PATCH /api/me/email {email}` → 204 | 400 | 403 | 409 | 429 | 404.

- [ ] **Step 1: Write the failing route tests**

Append to `server/src/routes/email-verification.test.ts`:

```ts
function tokenFrom(mailer: FakeMailer, index = 0): string {
  const match = mailer.sent[index].text.match(/\/verify-email\/(tpv_[A-Za-z0-9_-]+)/);
  if (!match) throw new Error("no verification link in the email");
  return match[1];
}

describe("verification routes", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  it("verify-email works without a session and unlocks the account (review focus 2)", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    const { cookie } = await unverifiedSession();
    await call(app, "POST", "/api/me/verify-email/resend", { cookie });
    const token = tokenFrom(mailer);

    const verify = await call(app, "POST", "/api/auth/verify-email", { body: { token } });

    expect(verify.statusCode).toBe(204);
    expect((await call(app, "GET", "/api/me", { cookie })).json().user.emailVerified).toBe(true);
    expect((await call(app, "POST", "/api/orgs", { cookie, body: { name: "Mine" } })).statusCode).toBe(201);
  });

  it("verify-email answers 400 for a bad or used token", async () => {
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const response = await call(app, "POST", "/api/auth/verify-email", { body: { token: "tpv_nope" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid or expired link" });
  });

  it("the routes don't exist when verification is off", async () => {
    const app = await buildTestApp(getTestDb(), { signup: "invite-only", mailer: new FakeMailer() });
    const { cookie } = await unverifiedSession();
    expect((await call(app, "POST", "/api/auth/verify-email", { body: { token: "tpv_x" } })).statusCode).toBe(404);
    expect((await call(app, "POST", "/api/me/verify-email/resend", { cookie })).statusCode).toBe(404);
    expect((await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "b@example.com" } })).statusCode).toBe(404);
  });

  it("resend: 204, then 429 with the wait, and 409 once verified", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/me/verify-email/resend", { cookie })).statusCode).toBe(204);
    const again = await call(app, "POST", "/api/me/verify-email/resend", { cookie });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: "Too many verification emails" });
    expect(again.json().retryAfterSeconds).toBeGreaterThan(100);

    await call(app, "POST", "/api/auth/verify-email", { body: { token: tokenFrom(mailer) } });
    const verified = await call(app, "POST", "/api/me/verify-email/resend", { cookie });
    expect(verified.statusCode).toBe(409);
    expect(verified.json()).toEqual({ error: "Email already verified" });
  });

  it("resend answers 204 and logs when SMTP fails", async () => {
    const failing = { send: vi.fn().mockRejectedValue(new Error("SMTP down")) };
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: failing });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "POST", "/api/me/verify-email/resend", { cookie })).statusCode).toBe(204);
    expect(failing.send).toHaveBeenCalledOnce();
  });

  it("change email: validates, refuses taken addresses, and sends a link to the new one", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    await createTestUser(getTestDb(), { email: "taken@example.com" });
    const { cookie } = await unverifiedSession();

    expect((await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "not-an-email" } })).statusCode).toBe(400);
    const taken = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "Taken@example.com" } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "Email already registered" });

    const changed = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "ana@example.org" } });
    expect(changed.statusCode).toBe(204);
    expect(mailer.sent.at(-1)?.to).toBe("ana@example.org");
    expect((await call(app, "GET", "/api/me", { cookie })).json().user.email).toBe("ana@example.org");
  });

  it("change email to the current address in another case resends (review focus 1)", async () => {
    const mailer = new FakeMailer();
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer });
    const { cookie } = await unverifiedSession();

    const response = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "Ana@Example.com" } });

    expect(response.statusCode).toBe(204);
    expect(mailer.sent).toHaveLength(1);
  });

  it("change email is refused once verified", async () => {
    const app = await buildTestApp(getTestDb(), { ...ACTIVE, mailer: new FakeMailer() });
    const user = await createTestUser(getTestDb());
    const cookie = await sessionCookie(getTestDb(), user.id);

    const response = await call(app, "PATCH", "/api/me/email", { cookie, body: { email: "new@example.com" } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Email already verified" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/email-verification.test.ts -t "verification routes"`
Expected: FAIL with 404s from the missing routes.

- [ ] **Step 3: Add `POST /api/auth/verify-email`**

In `server/src/routes/auth.ts`, add `verifyEmail` to the import from `../email-verification`, and at the end of `registerAuthRoutes` add:

```ts
  // No session needed: the link may be opened on another device. Answers only
  // 204 or 400, so it says nothing about which accounts exist.
  if (ctx.emailVerification) {
    app.post<{ Body: { token: string } }>(
      "/api/auth/verify-email",
      {
        schema: {
          body: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string", maxLength: 100 } },
            additionalProperties: false,
          },
        },
        config: { rateLimit },
      },
      async (request, reply) => {
        if (!(await verifyEmail(db, request.body.token))) {
          return reply.code(400).send({ error: "Invalid or expired link" });
        }
        return reply.code(204).send();
      }
    );
  }
```

- [ ] **Step 4: Add resend and change-email**

In `server/src/routes/me.ts`, add these imports:

```ts
import type { FastifyReply } from "fastify";
import { changeUnverifiedEmail, sendVerification, type ChangeEmailResult } from "../email-verification";
import { EMAIL_PATTERN } from "./auth";
```

(merge `FastifyReply` into the existing `import type { FastifyInstance } from "fastify";` line, and `EMAIL_PATTERN` into the existing `import { authRateLimit } from "./auth";`).

Above `registerMeRoutes`, add:

```ts
// Shared by resend and change-email. A send failure is logged and still
// answers 204: the link exists, and the user can resend after the cooldown.
function sendResultReply(reply: FastifyReply, result: ChangeEmailResult, alreadyVerifiedStatus: 403 | 409) {
  switch (result.status) {
    case "sent":
      return reply.code(204).send();
    case "already_verified":
      return reply.code(alreadyVerifiedStatus).send({ error: "Email already verified" });
    case "email_taken":
      return reply.code(409).send({ error: "Email already registered" });
    case "throttled":
      return reply.code(429).send({ error: "Too many verification emails", retryAfterSeconds: result.retryAfterSeconds });
  }
}
```

At the end of `registerMeRoutes`, add:

```ts
  const { mailer } = ctx;
  if (!ctx.emailVerification || !mailer) {
    return;
  }
  const unverifiedRoute = {
    preValidation: requireUser(db, true),
    config: { rateLimit: authRateLimit(ctx), allowUnverified: true },
  };

  app.post("/api/me/verify-email/resend", unverifiedRoute, async (request, reply) => {
    const user = currentUser(request);
    try {
      return sendResultReply(reply, await sendVerification(db, mailer, ctx.publicUrl, user), 409);
    } catch (error) {
      request.log.error({ err: error, userId: user.id }, "verification email failed");
      return reply.code(204).send();
    }
  });

  app.patch<{ Body: { email: string } }>(
    "/api/me/email",
    {
      ...unverifiedRoute,
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", maxLength: 254 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_PATTERN.test(email)) {
        return reply.code(400).send({ error: "Invalid email" });
      }
      try {
        return sendResultReply(reply, await changeUnverifiedEmail(db, mailer, ctx.publicUrl, user, email), 403);
      } catch (error) {
        request.log.error({ err: error, userId: user.id }, "verification email failed");
        return reply.code(204).send();
      }
    }
  );
```

Add `normalizeEmail` to the existing import from `../db/users`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/routes/email-verification.test.ts`
Expected: PASS.

- [ ] **Step 6: Check the isolation test still enumerates correctly**

Run: `npx vitest run src/routes/isolation.test.ts`
Expected: PASS. The new routes aren't org-scoped. If the test fails with "unlisted route", it's checking that every `/api/orgs/...` route is covered, and the new routes shouldn't match that; read the failure before changing anything.

- [ ] **Step 7: Full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes
git commit -m "feat(server): verify, resend and change-email routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cleanup job and startup warning

**Files:**
- Modify: `server/src/retention.ts`, `server/src/index.ts`
- Test: `server/src/retention.test.ts`

**Interfaces:**
- Consumes (Task 3): `deleteUnverifiedAccounts`, `deleteStaleEmailVerifications`, `isEmailVerificationActive`, `emailVerificationWarning`.
- Produces: `runCleanup(db, retentionDays, emailVerification): Promise<void>`; `scheduleCleanup(db, retentionDays, emailVerification, intervalMs?)`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/retention.test.ts` (add imports `eq` from `drizzle-orm`, `createTestUser` from `../test/db`, `users` from `./db/schema`, `findUserById` from `./db/users`, and `runCleanup` from `./retention`):

```ts
describe("runCleanup", () => {
  beforeEach(async () => {
    await resetDb(getTestDb());
  });

  async function staleUnverifiedUser() {
    const db = getTestDb();
    const user = await createTestUser(db, { emailVerified: false });
    await db.update(users).set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(users.id, user.id));
    return user;
  }

  it("deletes stale unverified accounts while verification is active", async () => {
    const user = await staleUnverifiedUser();
    await runCleanup(getTestDb(), 30, true);
    expect(await findUserById(getTestDb(), user.id)).toBeUndefined();
  });

  it("keeps them when verification is off (review focus 4)", async () => {
    const user = await staleUnverifiedUser();
    await runCleanup(getTestDb(), 30, false);
    expect(await findUserById(getTestDb(), user.id)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/retention.test.ts`
Expected: FAIL, `runCleanup` is not exported.

- [ ] **Step 3: Implement**

Replace `scheduleCleanup` in `server/src/retention.ts` with the following, and add imports `import { deleteStaleEmailVerifications } from "./db/email-verifications";` and `import { deleteUnverifiedAccounts } from "./email-verification";`:

```ts
export async function runCleanup(db: Database, retentionDays: number, emailVerification: boolean): Promise<void> {
  await Promise.all([
    cleanupOldTimelines(db, retentionDays),
    deleteExpiredSessions(db),
    deleteStalePasswordResets(db),
    deleteStaleEmailVerifications(db),
  ]);
  // Only while verification is on: after a switch back to invite-only, the
  // unverified users can use the app and must not be deleted.
  if (emailVerification) {
    const { skipped } = await deleteUnverifiedAccounts(db);
    for (const userId of skipped) {
      console.warn(`[tripcord-server] kept unverified user ${userId}: only owner of an org with other members`);
    }
  }
}

export function scheduleCleanup(
  db: Database,
  retentionDays: number,
  emailVerification: boolean,
  intervalMs: number = 24 * 60 * 60 * 1000
): ReturnType<typeof setInterval> {
  const run = () => {
    runCleanup(db, retentionDays, emailVerification).catch((error: unknown) => {
      console.error("[tripcord-server] cleanup job failed:", error);
    });
  };

  // Run once immediately at boot, not just on the interval — otherwise any
  // deployment that restarts more often than `intervalMs` (default 24h)
  // never enforces retention at all.
  run();
  return setInterval(run, intervalMs);
}
```

- [ ] **Step 4: Wire it up in `index.ts`**

In `server/src/index.ts`, add `import { emailVerificationWarning, isEmailVerificationActive } from "./email-verification";`. After `const app = await buildApp(...)`, add:

```ts
  const hasMailer = dashboard.email !== undefined;
  const warning = emailVerificationWarning(dashboard.signup, hasMailer);
  if (warning) {
    app.log.warn(warning);
  }
```

and change the cleanup call to:

```ts
  scheduleCleanup(db, retentionDays, isEmailVerificationActive(dashboard.signup, hasMailer));
```

- [ ] **Step 5: Run the tests, typecheck and lint**

Run: `npx vitest run src/retention.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/retention.ts server/src/retention.test.ts server/src/index.ts
git commit -m "feat(server): clean up unverified accounts and warn about open signup without SMTP

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Dashboard gate and "check your inbox" page

**Files:**
- Modify: `dashboard/src/types.ts`, `dashboard/src/test/fixtures.ts`, `dashboard/src/queryClient.ts`, `dashboard/src/components/RequireAuth.tsx`
- Create: `dashboard/src/pages/VerifyEmailPendingPage.tsx`, `dashboard/src/pages/verify-email.test.tsx`

**Interfaces:**
- Consumes (Tasks 4–5): `Me.user.emailVerified`; `POST /api/me/verify-email/resend`; `PATCH /api/me/email`; `DELETE /api/me` with `{ password }`; `POST /api/auth/logout`; `403 { error: "Email not verified" }`; `429 { error, retryAfterSeconds }`.
- Produces: `VerifyEmailPendingPage({ me }: { me: Me })`; `AuthConfig.emailVerification: boolean`; fixture `UNVERIFIED_ME`.

Commands in this task run from `dashboard/`.

- [ ] **Step 1: Update the types and fixtures**

In `dashboard/src/types.ts`, add `emailVerification: boolean;` to `AuthConfig`, and change `Me` to:

```ts
export interface Me {
  user: {
    id: string;
    email: string;
    name: string;
    hasPassword: boolean;
    githubConnected: boolean;
    /** False only while the server requires verification and it hasn't happened. */
    emailVerified: boolean;
  };
  orgs: UserOrg[];
}
```

In `dashboard/src/test/fixtures.ts`, add `emailVerified: true` to `ME.user`, add `emailVerification: false` to both `CONFIG_OPEN` and `CONFIG_CLOSED`, and append:

```ts
export const UNVERIFIED_ME: Me = { ...ME, user: { ...ME.user, emailVerified: false } };
```

Run: `npm run typecheck`
Expected: PASS. If another test file builds a `Me` literal without spreading `ME`, add `emailVerified: true` there.

- [ ] **Step 2: Write the failing tests**

Create `dashboard/src/pages/verify-email.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ME, ORG_ID, UNVERIFIED_ME } from "../test/fixtures";
import { mockApi, renderApp, type MockHandler } from "../test/utils";

const location = () => screen.getByTestId("location");

describe("unverified email", () => {
  it("shows only the check-your-inbox page, keeping the URL", async () => {
    mockApi({ "GET /api/me": { body: UNVERIFIED_ME } });
    renderApp(`/orgs/${ORG_ID}/projects`);

    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    expect(location()).toHaveTextContent(`/orgs/${ORG_ID}/projects`);
  });

  it("resends, and shows the wait after a 429", async () => {
    const handlers: Record<string, MockHandler> = {
      "GET /api/me": { body: UNVERIFIED_ME },
      "POST /api/me/verify-email/resend": { status: 204 },
    };
    const calls = mockApi(handlers);
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Resend email" }));
    expect(await screen.findByText("Sent. Check your inbox and spam folder.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/me/verify-email/resend")).toHaveLength(1);

    handlers["POST /api/me/verify-email/resend"] = {
      status: 429,
      body: { error: "Too many verification emails", retryAfterSeconds: 90 },
    };
    await user.click(screen.getByRole("button", { name: "Resend email" }));
    expect(await screen.findByText(/You can resend in 90 s/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resend email" })).toBeDisabled();
  });

  it("fixes a typo'd address", async () => {
    let me = UNVERIFIED_ME;
    const calls = mockApi({
      "GET /api/me": () => ({ body: me }),
      "PATCH /api/me/email": (body) => {
        me = { ...me, user: { ...me.user, email: (body as { email: string }).email } };
        return { status: 204 };
      },
    });
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Wrong address?" }));
    await user.type(screen.getByLabelText("New email"), "ana@example.org");
    await user.click(screen.getByRole("button", { name: "Change and resend" }));

    expect(await screen.findByText("ana@example.org")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ email: "ana@example.org" });
  });

  it("shows the server's error when the address is taken", async () => {
    mockApi({
      "GET /api/me": { body: UNVERIFIED_ME },
      "PATCH /api/me/email": { status: 409, body: { error: "Email already registered" } },
    });
    const user = userEvent.setup();
    renderApp("/");

    await user.click(await screen.findByRole("button", { name: "Wrong address?" }));
    await user.type(screen.getByLabelText("New email"), "taken@example.com");
    await user.click(screen.getByRole("button", { name: "Change and resend" }));

    expect(await screen.findByText("Email already registered")).toBeInTheDocument();
  });

  it("unlocks the app when the tab regains focus after verifying elsewhere", async () => {
    let me = UNVERIFIED_ME;
    mockApi({
      "GET /api/me": () => ({ body: me }),
      "GET /api/orgs/org-1/projects": { body: { projects: [] } },
    });
    renderApp(`/orgs/${ORG_ID}/projects`);
    await screen.findByRole("heading", { name: "Check your inbox" });

    me = ME;
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Check your inbox" })).not.toBeInTheDocument());
  });

  it("a 403 'Email not verified' from any request brings the page up", async () => {
    let me = ME;
    mockApi({
      "GET /api/me": () => ({ body: me }),
      "GET /api/orgs/org-1/projects": () => {
        me = UNVERIFIED_ME;
        return { status: 403, body: { error: "Email not verified" } };
      },
    });
    renderApp(`/orgs/${ORG_ID}/projects`);

    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/pages/verify-email.test.tsx`
Expected: FAIL, no "Check your inbox" heading.

- [ ] **Step 4: Refetch `me` on the verification 403**

In `dashboard/src/queryClient.ts`, replace `onUnauthorized` with:

```ts
  // A 401 from any request means the session is gone (expired, logged out
  // elsewhere, password changed); a 403 "Email not verified" means the server
  // started requiring verification. Either way, refetching "me" lets
  // RequireAuth show the right page. Skipped for "me" itself, which would loop.
  const onAuthError = (error: Error, queryKey?: readonly unknown[]) => {
    const authError =
      error instanceof ApiError && (error.status === 401 || (error.status === 403 && error.message === "Email not verified"));
    if (authError && queryKey?.[0] !== queryKeys.me[0]) {
      void client.invalidateQueries({ queryKey: queryKeys.me });
    }
  };
```

and rename the two uses of `onUnauthorized` below it to `onAuthError`.

- [ ] **Step 5: Create the pending page**

Create `dashboard/src/pages/VerifyEmailPendingPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { queryKeys } from "../queries";
import type { Me } from "../types";
import { AuthCard, Button, ErrorText, TextField } from "../components/ui";

function retryAfter(error: Error | null): number {
  return error instanceof ApiError && error.status === 429
    ? ((error.body as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0)
    : 0;
}

// Shown by RequireAuth in place of any page while the server requires
// verification. Offers only what an unverified account can do.
export function VerifyEmailPendingPage({ me }: { me: Me }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [wait, setWait] = useState(0);
  const [editing, setEditing] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  const resend = useMutation({
    mutationFn: () => api<void>("POST", "/api/me/verify-email/resend"),
    onError: (error) => setWait(retryAfter(error)),
  });
  const change = useMutation({
    mutationFn: () => api<void>("PATCH", "/api/me/email", { email: newEmail }),
    onSuccess: async () => {
      setEditing(false);
      setNewEmail("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) => setWait(retryAfter(error)),
  });
  const leave = () => {
    navigate("/login", { replace: true });
    queryClient.clear();
  };
  const logout = useMutation({ mutationFn: () => api<void>("POST", "/api/auth/logout"), onSuccess: leave });
  const deleteAccount = useMutation({ mutationFn: () => api<void>("DELETE", "/api/me", { password }), onSuccess: leave });

  return (
    <AuthCard title="Check your inbox">
      <div className="space-y-4 text-sm">
        <p>
          We sent a link to <strong>{me.user.email}</strong>. Open it to finish signing up.
        </p>

        <div className="space-y-2">
          <Button variant="secondary" onClick={() => resend.mutate()} disabled={resend.isPending || wait > 0}>
            Resend email
          </Button>
          {resend.isSuccess && wait === 0 && <p className="text-muted">Sent. Check your inbox and spam folder.</p>}
          {wait > 0 && <p className="text-muted">You can resend in {wait} s.</p>}
          {resend.error && retryAfter(resend.error) === 0 && <ErrorText error={resend.error} />}
        </div>

        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              change.mutate();
            }}
          >
            <TextField label="New email" type="email" autoComplete="email" value={newEmail} onChange={setNewEmail} required maxLength={254} />
            {change.error && retryAfter(change.error) === 0 && <ErrorText error={change.error} />}
            <Button type="submit" disabled={change.isPending || wait > 0}>
              Change and resend
            </Button>
          </form>
        ) : (
          <button type="button" className="text-accent hover:underline" onClick={() => setEditing(true)}>
            Wrong address?
          </button>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Log out
          </Button>
          <button type="button" className="text-danger hover:underline" onClick={() => setDeleting((open) => !open)}>
            Delete account
          </button>
        </div>

        {deleting && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              deleteAccount.mutate();
            }}
          >
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} required />
            <ErrorText error={deleteAccount.error} />
            <Button type="submit" variant="danger" disabled={deleteAccount.isPending || password === ""}>
              Delete my account
            </Button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}
```

Unverified accounts always have a password (GitHub signups start verified), so the delete form always asks for one. The spec mentioned reusing the settings page's confirmation, but that page sits behind the gate, so the form lives here. (`border-border` is the theme's border color, as used by `Button` and `TextField`.)

- [ ] **Step 6: Render it from `RequireAuth`**

In `dashboard/src/components/RequireAuth.tsx`, import `VerifyEmailPendingPage` from `../pages/VerifyEmailPendingPage`, and replace the `if (me.data)` block with:

```tsx
  // Checked before other errors: a failed background refetch keeps the page up.
  if (me.data) {
    // The URL stays as it is, so the page the user asked for opens once they verify.
    return me.data.user.emailVerified ? <Outlet /> : <VerifyEmailPendingPage me={me.data} />;
  }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/pages/verify-email.test.tsx`
Expected: PASS.

If the focus test fails because React Query didn't refetch: `createQueryClient` doesn't set `staleTime`, so `me` is stale and refetches on focus. Check that the test dispatched `visibilitychange` on `window`, which is what TanStack Query's `focusManager` listens to.

- [ ] **Step 8: Full dashboard suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add dashboard/src
git commit -m "feat(dashboard): check-your-inbox page for unverified accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dashboard `/verify-email/:token` page

**Files:**
- Create: `dashboard/src/pages/VerifyEmailPage.tsx`
- Modify: `dashboard/src/App.tsx`, `dashboard/src/test/utils.tsx`
- Test: `dashboard/src/pages/verify-email.test.tsx`

**Interfaces:**
- Consumes (Task 5): `POST /api/auth/verify-email {token}` → 204 | 400.
- Produces: public route `/verify-email/:token`.

- [ ] **Step 1: Write the failing tests**

Append to `dashboard/src/pages/verify-email.test.tsx`:

```tsx
describe("verify-email link", () => {
  it("verifies the token exactly once and links into the app (review focus 3)", async () => {
    const calls = mockApi({
      "GET /api/me": { status: 401, body: { error: "Not logged in" } },
      "POST /api/auth/verify-email": { status: 204 },
    });
    renderApp("/verify-email/tpv_tok");

    expect(await screen.findByRole("heading", { name: "Email verified" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue to Tripcord" })).toHaveAttribute("href", "/");
    const posts = calls.filter((c) => c.path === "/api/auth/verify-email");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ token: "tpv_tok" });
  });

  it("explains a dead link", async () => {
    mockApi({
      "GET /api/me": { status: 401, body: { error: "Not logged in" } },
      "POST /api/auth/verify-email": { status: 400, body: { error: "Invalid or expired link" } },
    });
    renderApp("/verify-email/tpv_old");

    expect(await screen.findByRole("heading", { name: "Link expired" })).toBeInTheDocument();
    expect(screen.getByText("This link is invalid or has expired. Log in to send a new one.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
  });
});
```

`renderApp` doesn't use `<StrictMode>` (only `main.tsx` does), so without a change the "exactly once" assertion wouldn't cover StrictMode's double effect. In `dashboard/src/test/utils.tsx`, give `renderApp` an option and wrap the routes when it's set:

```tsx
import { StrictMode } from "react";

/** Renders the whole app at `path`, plus a data-testid="location" probe. */
export function renderApp(path: string, options: { strict?: boolean } = {}) {
  const client = createQueryClient();
  const routes = (
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>
  );
  render(<QueryClientProvider client={client}>{options.strict ? <StrictMode>{routes}</StrictMode> : routes}</QueryClientProvider>);
  return { client };
}
```

Then change the first test's render to `renderApp("/verify-email/tpv_tok", { strict: true });`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/pages/verify-email.test.tsx -t "verify-email link"`
Expected: FAIL. The route doesn't exist, so the page shows the not-found page.

- [ ] **Step 3: Create the page**

Create `dashboard/src/pages/VerifyEmailPage.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "../queries";
import { AuthCard, FullPageMessage } from "../components/ui";

// Public: the link may be opened on a device with no session. Posts the token
// once per page load; the ref stops StrictMode's second effect run from using
// up the token and then showing "expired".
export function VerifyEmailPage() {
  const { token = "" } = useParams();
  const queryClient = useQueryClient();
  const sent = useRef(false);
  const verify = useMutation({
    mutationFn: () => api<void>("POST", "/api/auth/verify-email", { token }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    verify.mutate();
  }, [verify]);

  if (verify.isSuccess) {
    return (
      <AuthCard title="Email verified">
        <Link className="text-sm text-accent hover:underline" to="/">
          Continue to Tripcord
        </Link>
      </AuthCard>
    );
  }
  if (verify.isError) {
    return (
      <AuthCard title="Link expired">
        <p className="text-sm">This link is invalid or has expired. Log in to send a new one.</p>
        <Link className="text-sm text-accent hover:underline" to="/login">
          Log in
        </Link>
      </AuthCard>
    );
  }
  return <FullPageMessage>Verifying…</FullPageMessage>;
}
```

- [ ] **Step 4: Add the route**

In `dashboard/src/App.tsx`, import `VerifyEmailPage` from `./pages/VerifyEmailPage` and add, after the `/reset-password/:token` route:

```tsx
      <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/pages/verify-email.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full dashboard suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src
git commit -m "feat(dashboard): verify-email link page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs

**Files:**
- Modify: `server/README.md`, `docs/self-hosting.md`, `docs/superpowers/specs/2026-09-24-tripcord-hosted-beta-design.md`

- [ ] **Step 1: `server/README.md`**

In the environment variables table, change the `SMTP_URL` description to end with: `With SIGNUP=open, also turns on email verification for password signups.`

In the "Hosted-beta additions" list of API notes, add after the password-reset bullet:

```markdown
- Email verification (see `docs/superpowers/specs/2026-09-24-tripcord-email-verification-design.md`)
  is active with `SIGNUP=open` and SMTP configured. Then password signups start
  unverified, and every cookie-authenticated route except `GET /api/me`,
  `DELETE /api/me`, `POST /api/me/verify-email/resend` and `PATCH /api/me/email`
  answers `403 { "error": "Email not verified" }` until the user opens the emailed
  link, which calls `POST /api/auth/verify-email`. These three routes exist only
  while verification is active. `GET /api/me` includes `user.emailVerified`, and
  `GET /api/auth/config` includes `emailVerification`.
```

- [ ] **Step 2: `docs/self-hosting.md`**

In the "Email (optional)" section, after the first paragraph, add:

```markdown
With `SIGNUP=open`, SMTP also turns on email verification: people who sign up with a
password must open a link sent to their address before they can use Tripcord.
Accounts nobody verifies are deleted after 7 days. GitHub sign-ups are already
verified by GitHub. Open signup without SMTP still works, without verification or
password reset, and the server logs a warning at startup.
```

- [ ] **Step 3: The hosted-beta spec**

In `docs/superpowers/specs/2026-09-24-tripcord-hosted-beta-design.md`:
- In the Decisions table row `Email verification`, replace its text with: `Not in this sub-project; see [the email verification design](2026-09-24-tripcord-email-verification-design.md).`
- In "Explicitly out of scope", delete the line `- Email verification, and running \`SIGNUP=open\` in public.`

- [ ] **Step 4: Commit**

```bash
git add server/README.md docs/self-hosting.md docs/superpowers/specs/2026-09-24-tripcord-hosted-beta-design.md
git commit -m "docs: email verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Final check

- [ ] **Step 1: Everything from the repo root**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

- [ ] **Step 2: Spec status**

In `docs/superpowers/specs/2026-09-24-tripcord-email-verification-design.md`, change `Status: draft` to `Status: approved`, and under "Decisions" add a row:

```markdown
| Daily limit | At most 5 verification emails per user per 24 hours, across resends and address changes. Added during planning: without it, changing the address could mail arbitrary people every few seconds. |
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-24-tripcord-email-verification-design.md
git commit -m "docs: record the verification email daily limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Manual checks on `app.tripcord.dev` after deploying with `SIGNUP=open` are listed in the spec's Testing section.
