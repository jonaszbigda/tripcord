# Tripcord — email verification design

Status: approved
Date: 2026-09-24
Scope: confirming that a password signup owns its email address, so an instance can
run `SIGNUP=open` in public. Covers the schema, the gate on the dashboard API, the
verification email and routes, cleanup of accounts nobody verifies, the dashboard
screens, and docs. Follows on from
[the hosted-beta design](2026-09-24-tripcord-hosted-beta-design.md), which left
verification out of scope.

## Problem

Nothing checks that a password signup owns the address it typed. On an
`invite-only` instance that's acceptable: every account comes through an invite the
operator sent. With `SIGNUP=open`, anyone can:

- sign up with a fake or mistyped address, which then gets password-reset and
  invite mail meant for someone else, or reaches nobody;
- register someone else's address in advance, so its owner can't sign up.

The goal is to be able to run `SIGNUP=open` on `app.tripcord.dev`: an account can't
be used until its email is confirmed.

GitHub signups aren't affected. `auth/github.ts` only accepts GitHub's verified
primary email, so those accounts are verified from the start.

## Decisions

| Topic | Decision |
|---|---|
| What verification is for | A hard gate on open instances: an unverified account can't use the app. Not a soft "please verify" banner. |
| When it's active | Exactly when `SIGNUP=open` **and** SMTP is configured. No new environment variable. |
| Open signup without SMTP | Allowed. The server starts without verification and logs a warning (below). SMTP stays optional for self-hosters. |
| `invite-only` | No verification, whether or not SMTP is configured. Unchanged from today. |
| Mechanism | A one-time link, built like password reset: an `email_verifications` table of token hashes, `tpv_` tokens, 24-hour expiry. Not a typed code (needs guess limiting) and not a signed stateless token (needs a new server secret, and can't be single-use). |
| Unverified user experience | They get a session at signup, but every dashboard API route except a short allowlist answers `403`. The dashboard shows only a "check your inbox" screen. |
| Existing users | The migration marks every existing user verified. They all came through the operator's invites. |
| GitHub signups | Verified at creation. |
| Password reset | Using a reset link also verifies the account, since it proves inbox access. This is how the real owner takes back an address someone else registered. The reset already ends every other session. |
| Abandoned signups | Accounts unverified for 7 days are deleted by the daily retention job, which frees the address. |
| Switching back to `invite-only` | The gate and the cleanup are off whenever verification is inactive, so existing unverified users can then use the app rather than being locked out or deleted. |
| Changing address | Only while unverified, to fix a typo. Changing the email of a verified account stays out of scope. |
| Daily limit | At most 5 verification emails per user per 24 hours, across resends and address changes. Added during planning: without it, changing the address could mail arbitrary people every few seconds. |

The startup warning, logged once by `index.ts` when `SIGNUP=open` and SMTP is not
configured:

> `SIGNUP=open without SMTP: signup emails are not verified and password reset is unavailable. Set SMTP_URL and EMAIL_FROM to enable both.`

## Data model

One migration:

- `users.email_verified_at timestamp` (nullable). The migration sets it to
  `created_at` for every existing row.
- New table `email_verifications`:

| Column | Type | Notes |
|---|---|---|
| `token_hash` | `text` primary key | SHA-256 of the `tpv_` token. The token only travels in the email. |
| `user_id` | `uuid` not null → `users.id` | Indexed. |
| `email` | `text` not null | The address the link was sent to. |
| `created_at` | `timestamp` not null | Set from the server's clock, as in `password_resets`, for the cooldown. |
| `expires_at` | `timestamp` not null | `created_at` + 24 hours. |
| `used_at` | `timestamp` | Set when the link is used. |

Storing `email` means a link only verifies the address it was sent to. After a
typo fix, links sent to the old address stop working.

Account deletion (`deletion.ts`) removes a user's `email_verifications` rows, as it
does for `password_resets`.

## Server

### Configuration

`loadConfig` stays unchanged. `index.ts` and `cli.ts` build
`emailVerification = config.signup === "open" && config.email !== undefined` and put
it on the API context as `ctx.emailVerification: boolean`. The rest of the server
reads only that flag.

### Module: `server/src/email-verification.ts`

Beside `password-reset.ts`, with its data access in `server/src/db/email-verifications.ts`.

- `EMAIL_VERIFICATION_COOLDOWN_MS = 2 * 60 * 1000`,
  `EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000`,
  `UNVERIFIED_ACCOUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000`.
- `sendVerification(db, mailer, publicUrl, user): Promise<"sent" | "cooldown" | "already_verified">`
  checks the cooldown against the user's latest token, creates a token for
  `user.email`, and sends `verifyEmailMail` with `${publicUrl}/verify-email/${token}`.
- `verifyEmail(db, token): Promise<boolean>` marks the token used and sets
  `email_verified_at = now()`, in one transaction. It returns false if the token is
  unknown, used or expired, or if its `email` no longer matches the user's.
- `changeUnverifiedEmail(db, userId, email): Promise<"ok" | "email_taken" | "already_verified">`
  updates the address and marks the user's outstanding tokens used, in one
  transaction. The caller then sends a new link.

### The gate

`requireUser` takes the context flag. When `ctx.emailVerification` is true and the
user's `email_verified_at` is null, it answers
`403 { "error": "Email not verified" }`, unless the route opts out with the route
config flag `allowUnverified: true`. Only these routes set it:

- `GET /api/me`
- `DELETE /api/me`
- `POST /api/me/verify-email/resend`
- `PATCH /api/me/email`

`POST /api/auth/logout` and ingest (`X-Tripcord-Key`) aren't behind `requireUser`,
so they're unaffected. An unverified user can't create keys in the first place.

`requireUser(db)` becomes `requireUser(db, emailVerification)`; its callers pass
`ctx.emailVerification`.

### Signup

- **Password signup:** the user is created with `email_verified_at = null`, and the
  session starts as today. When `ctx.emailVerification` is true, `sendVerification`
  runs after the reply is sent. A send failure is logged (without the token) and
  doesn't affect the response. When verification is inactive, the user is created
  with `email_verified_at = now()`.
- **GitHub signup:** `email_verified_at = now()`.
- **Signup invite (admin CLI):** unchanged. The account is created through the same
  signup routes above.

### Routes

| Route | Auth | Behaviour |
|---|---|---|
| `POST /api/auth/verify-email` `{ token }` | none | `204` if `verifyEmail` succeeds, else `400 Invalid or expired link`. It needs no session, so the link works in any browser. Registered only when `ctx.emailVerification` is true. Otherwise `404`. |
| `POST /api/me/verify-email/resend` | session, `allowUnverified` | `204` when sent. `409 Email already verified`. `429 { error, retryAfterSeconds }` during the cooldown. `404` when verification is inactive. |
| `PATCH /api/me/email` `{ email }` | session, `allowUnverified` | Normalizes and validates the address like signup does (`EMAIL_PATTERN`, max 254). `204`, then sends a new link. `409 Email already registered`. `403 Email already verified`. `404` when verification is inactive. |

All three use the per-IP auth rate limit from `routes/auth.ts`.

`GET /api/me` (and the signup and login responses that share its body) gains
`emailVerified: boolean`. `GET /api/auth/config` gains `emailVerification: boolean`.

### Password reset

`resetPassword` also sets `email_verified_at = now()` when it's null, in the same
transaction.

A reset link is bound to the address it was sent to: `password_resets` gains a
not-null `email` column, and `resetPassword` refuses a link whose address no
longer matches the user's. Migration 0006 drops unverified users' pending links
and fills the column from `users` for the rest.

`changeUnverifiedEmail` writes the new address only while the row is still
unverified (`UPDATE … WHERE email_verified_at IS NULL`), and answers
`already_verified` otherwise. The request's user was read before the change, so
a link used in parallel could otherwise verify the old address and then have the
new one swapped in.
Changing an unverified address also deletes pending reset links. Without the
binding, a reset requested at the same moment as an address change could be
stored after the change and then verify an address its sender never proved.

### Retention

The daily job in `retention.ts` gains two steps:

- Delete `email_verifications` rows that are used or expired, like
  `deleteStalePasswordResets`.
- **Only when `ctx.emailVerification` is true:** delete users whose
  `email_verified_at` is null and `created_at` is older than 7 days. Each goes
  through `deleteUser` in `deletion.ts`, the same path as `user delete`, so orgs
  where they're the only member go with them. If `deleteUser` refuses (the user
  is the only owner of an org with other members), the user is skipped and
  logged by ID; the next run tries again.

`scheduleCleanup` gains an `emailVerification: boolean` parameter for this.

### Email

`verifyEmailMail(to, name, link)` in `email.ts`, plain text:

```
Subject: Confirm your Tripcord email

Hi <name>,

To finish signing up for Tripcord, confirm your email address:

<link>

This link expires in 24 hours. If you didn't sign up for Tripcord, ignore this
email and the account will be deleted in 7 days.
```

## Dashboard

- **`RequireAuth`:** when `me.emailVerified` is false, it renders
  `VerifyEmailPendingPage` in place of the requested page. The URL stays the same,
  so a deep link still works once the user is verified.
- **`VerifyEmailPendingPage`:**
  - "We sent a link to **<email>**. Open it to finish signing up."
  - **Resend email** button. After a `429` it shows "You can resend in N s", using
    `retryAfterSeconds`.
  - **Wrong address?** opens an inline form that calls `PATCH /api/me/email`, then
    shows the new address.
  - **Log out**, and a small **Delete account** link that uses the existing confirm
    dialog.
  - Refetches `/api/me` when the window regains focus, so verifying in another tab
    or on a phone unlocks the app. There's no polling.
- **`/verify-email/:token`:** a public route, `VerifyEmailPage`, beside
  `/reset-password/:token`.
  - On mount it posts the token once, guarded with a ref so StrictMode's double
    effect doesn't use the token twice.
  - On success: "Email verified", then invalidates `me` and links into the app.
  - On `400`: "This link is invalid or has expired. Log in to send a new one."
- **API client:** a `403` with `Email not verified` invalidates the `me` query, so the
  gate takes over. This covers verification being switched on during a session.
- **Signup:** unchanged. After a password signup on an instance with verification
  active, `me.emailVerified` is false, so the user lands on the pending page.

## Error handling and security

- Tokens are never logged, the same as reset tokens. Send failures log the error
  and the user ID only.
- `POST /api/auth/verify-email` only answers `204` or `400`, so it reveals nothing
  about which accounts or addresses exist.
- `PATCH /api/me/email` answering `409` reveals that an address is registered, the
  same as signup does today.
- Someone who registers another person's address gets an account they can't use.
  The owner can take it over with "forgot password", which verifies it and ends the
  other sessions. Otherwise it's deleted after 7 days.

## Testing

The same layers and tools as the existing tests: Vitest, a Postgres test container
for anything touching the database, and a fake `Mailer`.

**Server**
- **Config/context:** `emailVerification` for all four combinations of `SIGNUP`
  and SMTP. The startup warning is logged only for `open` without SMTP.
- **`email-verification`:**
  - send, then verify
  - expired, reused and unknown tokens
  - a token whose `email` no longer matches the user's
  - cooldown
  - `changeUnverifiedEmail`: marks old tokens used, rejects a taken address,
    refuses a verified user
- **Password reset:** consuming a reset verifies an unverified user.
- **Routes:**
  - the gate returns `403` on a gated route and lets the allowlisted routes through
  - the gate is off on `invite-only` and when SMTP isn't set
  - password signup sends a link when verification is active; GitHub signup starts
    verified
  - `verify-email`, `resend` and `PATCH /api/me/email` answer each of the statuses
    listed above
- **Retention:** deletes unverified users older than 7 days only when verification
  is active, and leaves verified and newer users alone. Cleans up stale tokens.
- **Migration:** existing users end up with `email_verified_at` set.

**Dashboard**
- The pending page renders for an unverified `me`, and handles resend, the `429`
  countdown and changing the address.
- The verify page shows success and invalid-link states, and posts the token
  exactly once.
- A `403 Email not verified` from any query shows the pending page.

**Manual**, on `app.tripcord.dev` after switching to `SIGNUP=open`:
- Sign up with a password, open the link on another device, and check the app
  unlocks on focus.
- Fix a typo'd address from the pending page.
- Check that an old link fails after changing the address.

## Docs

- `server/README.md`: the new routes, the `emailVerified` and `emailVerification`
  fields, and when verification is active.
- `docs/self-hosting.md`, in the Email section: `SIGNUP=open` with SMTP turns on
  verification; without SMTP the server warns at startup.
- The hosted-beta spec: remove "email verification" from its out-of-scope list and
  link to this spec.

## Explicitly out of scope

- Changing the email of a verified account.
- Verifying email for accounts created by invite on `invite-only` instances.
- A setting to require verification regardless of `SIGNUP`, or to turn it off on an
  open instance with SMTP.
- Typed verification codes.
- HTML email.
