CREATE TABLE IF NOT EXISTS "password_resets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_resets_user_idx" ON "password_resets" USING btree ("user_id");