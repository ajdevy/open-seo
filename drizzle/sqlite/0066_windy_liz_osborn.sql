CREATE TABLE `ai_provider_run_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`reserved_usd_micros` integer NOT NULL,
	`accounted_usd_micros` integer,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `ai_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_provider_run_reservations_run_idx` ON `ai_provider_run_reservations` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_provider_run_reservations_project_active_idx` ON `ai_provider_run_reservations` (`project_id`) WHERE "ai_provider_run_reservations"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX `ai_provider_run_reservations_project_created_idx` ON `ai_provider_run_reservations` (`project_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `ai_trackers` ADD `weekly_provider_budget_cents` integer DEFAULT 800 NOT NULL;
