CREATE TABLE "ai_native_results" (
	"id" text PRIMARY KEY NOT NULL,
	"schema_version" integer NOT NULL,
	"client_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"question_id" text NOT NULL,
	"question_version" integer NOT NULL,
	"question_snapshot" text NOT NULL,
	"requested_model" text NOT NULL,
	"observed_model" text,
	"route" text NOT NULL,
	"result_status" text NOT NULL,
	"answer" text,
	"search_status" text NOT NULL,
	"eligible_for_visibility" boolean,
	"error_code" text,
	"turn_status" text,
	"collected_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_native_search_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"tool" text NOT NULL,
	"status" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_native_search_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"value" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_native_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"result_id" text NOT NULL,
	"value" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_native_results" ADD CONSTRAINT "ai_native_results_client_id_organization_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_native_results" ADD CONSTRAINT "ai_native_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_native_results" ADD CONSTRAINT "ai_native_results_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_native_results" ADD CONSTRAINT "ai_native_results_question_id_ai_prompts_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."ai_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_native_search_evidence" ADD CONSTRAINT "ai_native_search_evidence_result_id_ai_native_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."ai_native_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_native_search_sources" ADD CONSTRAINT "ai_native_search_sources_result_id_ai_native_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."ai_native_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_native_sources" ADD CONSTRAINT "ai_native_sources_result_id_ai_native_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."ai_native_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_native_results_run_question_version_model_route_idx" ON "ai_native_results" USING btree ("run_id","question_id","question_version","requested_model","route");--> statement-breakpoint
CREATE INDEX "ai_native_results_project_collected_idx" ON "ai_native_results" USING btree ("project_id","collected_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_native_search_evidence_result_position_idx" ON "ai_native_search_evidence" USING btree ("result_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_native_search_sources_result_position_idx" ON "ai_native_search_sources" USING btree ("result_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_native_sources_result_position_idx" ON "ai_native_sources" USING btree ("result_id","position");