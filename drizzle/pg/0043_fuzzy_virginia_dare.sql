CREATE TABLE "project_settings_snapshot_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"algorithm" text NOT NULL,
	"schema_version" integer NOT NULL,
	"iv" text NOT NULL,
	"ciphertext" text NOT NULL,
	"status" text DEFAULT 'unconfirmed' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"confirmed_at" text
);
--> statement-breakpoint
CREATE TABLE "project_settings_snapshot_revisions" (
	"project_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_settings_snapshot_outbox" ADD CONSTRAINT "project_settings_snapshot_outbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settings_snapshot_revisions" ADD CONSTRAINT "project_settings_snapshot_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_settings_snapshot_outbox_revision_idx" ON "project_settings_snapshot_outbox" USING btree ("project_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "project_settings_snapshot_outbox_idempotency_idx" ON "project_settings_snapshot_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "project_settings_snapshot_outbox_status_idx" ON "project_settings_snapshot_outbox" USING btree ("status","project_id","revision");