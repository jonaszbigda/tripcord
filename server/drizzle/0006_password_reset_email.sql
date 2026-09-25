ALTER TABLE "password_resets" ADD COLUMN "email" text;--> statement-breakpoint
-- An unverified account's pending link may predate an address change, and the
-- backfill below would bind it to the new address. They can request a new one.
DELETE FROM "password_resets" USING "users" WHERE "users"."id" = "password_resets"."user_id" AND "password_resets"."used_at" IS NULL AND "users"."email_verified_at" IS NULL;--> statement-breakpoint
-- Links issued before this migration went to the user's address at the time,
-- which is their current one unless it changed in the last hour.
UPDATE "password_resets" SET "email" = "users"."email" FROM "users" WHERE "users"."id" = "password_resets"."user_id";--> statement-breakpoint
ALTER TABLE "password_resets" ALTER COLUMN "email" SET NOT NULL;
