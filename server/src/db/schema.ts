import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
    receivedAt: timestamp("received_at").notNull().defaultNow(),
  },
  (table) => ({
    projectReceivedIdx: index("timelines_project_received_idx").on(table.projectId, table.receivedAt),
    projectReasonTypeIdx: index("timelines_project_reason_type_idx").on(table.projectId, table.reasonType),
  })
);

export type Project = typeof projects.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Timeline = typeof timelines.$inferSelect;
