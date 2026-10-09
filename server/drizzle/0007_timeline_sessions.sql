CREATE TABLE IF NOT EXISTS "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"reason_type" text NOT NULL,
	"reason" jsonb NOT NULL,
	"meta" jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "timeline_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"pending_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_sessions_project_session_uq" UNIQUE("project_id","session_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "captures" ADD CONSTRAINT "captures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "timeline_sessions" ADD CONSTRAINT "timeline_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "captures_project_received_idx" ON "captures" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "captures_project_reason_type_idx" ON "captures" USING btree ("project_id","reason_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "captures_project_session_idx" ON "captures" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "captures_tags_idx" ON "captures" USING gin ("tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeline_sessions_project_updated_idx" ON "timeline_sessions" USING btree ("project_id","updated_at");