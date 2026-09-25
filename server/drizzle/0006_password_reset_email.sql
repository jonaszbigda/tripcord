ALTER TABLE "password_resets" ADD COLUMN "email" text;--> statement-breakpoint
-- Links issued before this migration went to the user's address at the time,
-- which is their current one unless it changed in the last hour.
UPDATE "password_resets" SET "email" = "users"."email" FROM "users" WHERE "users"."id" = "password_resets"."user_id";--> statement-breakpoint
ALTER TABLE "password_resets" ALTER COLUMN "email" SET NOT NULL;
