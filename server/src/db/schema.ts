import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, primaryKey } from "drizzle-orm/pg-core";

export const ROLES = ["owner", "member"] as const;
export type Role = (typeof ROLES)[number];

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Stored trimmed and lowercased — see normalizeEmail() in db/users.ts.
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  // NULL for users who only log in with GitHub. Format: see auth/password.ts.
  passwordHash: text("password_hash"),
  // GitHub's numeric user id, as text.
  githubId: text("github_id").unique(),
  // NULL until the owner opens a verification link. Only enforced while
  // verification is active (SIGNUP=open with SMTP); see email-verification.ts.
  emailVerifiedAt: timestamp("email_verified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    // SHA-256 of the cookie token. The token itself is never stored.
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Fixed at creation (30 days); not extended on use.
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => ({
    userIdx: index("sessions_user_idx").on(table.userId),
  })
);

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // Plain text, not a Postgres enum: validity is enforced in code, so a new
    // role is a code change rather than a migration.
    role: text("role").$type<Role>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.userId] }),
    userIdx: index("memberships_user_idx").on(table.userId),
  })
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL for a signup invite, which creates a new account with its own org
    // (see signUp in accounts.ts). Only the admin CLI creates those.
    orgId: uuid("org_id").references(() => orgs.id),
    // SHA-256 of the tpi_ token. The token is shown once, at creation.
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role").$type<Role>().notNull(),
    // NULL for invites made by the admin CLI, and once the creator deletes their account.
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    orgIdx: index("invites_org_idx").on(table.orgId),
  })
);

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

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("projects_org_idx").on(table.orgId),
  })
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    // SHA-256 of the full key, lowercase hex. The plaintext key is never stored.
    keyHash: text("key_hash").notNull().unique(),
    // First 12 characters of the key, so keys can be told apart in listings.
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // NULL = active. Revocation is a soft delete so there's a record of which keys existed.
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    projectIdx: index("api_keys_project_idx").on(table.projectId),
  })
);

export const timelines = pgTable(
  "timelines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id),
    sessionId: text("session_id").notNull(),
    reasonType: text("reason_type").notNull(),
    reason: jsonb("reason").notNull(),
    events: jsonb("events").notNull(),
    meta: jsonb("meta").notNull(),
    // Where the error happened, set by the client (see server/src/tags.ts).
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => ({
    projectReceivedIdx: index("timelines_project_received_idx").on(table.projectId, table.receivedAt),
    projectReasonTypeIdx: index("timelines_project_reason_type_idx").on(table.projectId, table.reasonType),
    projectSessionIdx: index("timelines_project_session_idx").on(table.projectId, table.sessionId),
    tagsIdx: index("timelines_tags_idx").using("gin", table.tags),
  })
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type PasswordReset = typeof passwordResets.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Timeline = typeof timelines.$inferSelect;
