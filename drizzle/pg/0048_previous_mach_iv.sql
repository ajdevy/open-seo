CREATE TABLE "ai_provider_run_budget_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_run_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"reserved_usd_micros" bigint NOT NULL,
	"accounted_usd_micros" bigint,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" text NOT NULL,
	"settled_at" text,
	"reconciliation_reference" text,
	"reconciled_at" text
);
--> statement-breakpoint
ALTER TABLE "ai_trackers" ADD COLUMN "weekly_provider_budget_cents" integer DEFAULT 800 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_run_reservations" ADD CONSTRAINT "ai_provider_run_reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_run_reservations" ADD CONSTRAINT "ai_provider_run_reservations_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_run_reservations_run_idx" ON "ai_provider_run_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_run_reservations_project_active_idx" ON "ai_provider_run_reservations" USING btree ("project_id") WHERE "ai_provider_run_reservations"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX "ai_provider_run_reservations_project_created_idx" ON "ai_provider_run_reservations" USING btree ("project_id","created_at");