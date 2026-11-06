CREATE TABLE `ai_native_results` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`client_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_version` integer NOT NULL,
	`question_snapshot` text NOT NULL,
	`requested_model` text NOT NULL,
	`observed_model` text,
	`route` text NOT NULL,
	`result_status` text NOT NULL,
	`answer` text,
	`search_status` text NOT NULL,
	`eligible_for_visibility` integer,
	`error_code` text,
	`turn_status` text,
	`collected_at` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `ai_prompts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_native_results_run_question_version_model_route_idx` ON `ai_native_results` (`run_id`,`question_id`,`question_version`,`requested_model`,`route`);--> statement-breakpoint
CREATE INDEX `ai_native_results_project_collected_idx` ON `ai_native_results` (`project_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `ai_native_search_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`result_id` text NOT NULL,
	`tool` text NOT NULL,
	`status` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`result_id`) REFERENCES `ai_native_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_native_search_evidence_result_position_idx` ON `ai_native_search_evidence` (`result_id`,`position`);--> statement-breakpoint
CREATE TABLE `ai_native_search_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`result_id` text NOT NULL,
	`value` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`result_id`) REFERENCES `ai_native_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_native_search_sources_result_position_idx` ON `ai_native_search_sources` (`result_id`,`position`);--> statement-breakpoint
CREATE TABLE `ai_native_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`result_id` text NOT NULL,
	`value` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`result_id`) REFERENCES `ai_native_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_native_sources_result_position_idx` ON `ai_native_sources` (`result_id`,`position`);