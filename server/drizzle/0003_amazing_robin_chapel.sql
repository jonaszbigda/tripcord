ALTER TABLE "timelines" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timelines_project_session_idx" ON "timelines" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timelines_tags_idx" ON "timelines" USING gin ("tags");