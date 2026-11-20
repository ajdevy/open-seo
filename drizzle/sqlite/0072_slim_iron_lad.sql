PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_provider_run_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`reserved_usd_micros` integer NOT NULL,
	`accounted_usd_micros` integer,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` text NOT NULL,
	`settled_at` text,
	`reconciliation_reference` text,
	`reconciled_at` text
);
--> statement-breakpoint
INSERT INTO `__new_ai_provider_run_reservations`("id", "project_id", "run_id", "reserved_usd_micros", "accounted_usd_micros", "status", "created_at", "settled_at", "reconciliation_reference", "reconciled_at") SELECT "id", "project_id", "run_id", "reserved_usd_micros", "accounted_usd_micros", "status", "created_at", "settled_at", "reconciliation_reference", "reconciled_at" FROM `ai_provider_run_reservations`;--> statement-breakpoint
DROP TABLE `ai_provider_run_reservations`;--> statement-breakpoint
ALTER TABLE `__new_ai_provider_run_reservations` RENAME TO `ai_provider_run_reservations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `ai_provider_run_reservations_run_idx` ON `ai_provider_run_reservations` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_provider_run_reservations_project_active_idx` ON `ai_provider_run_reservations` (`project_id`) WHERE "ai_provider_run_reservations"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX `ai_provider_run_reservations_project_created_idx` ON `ai_provider_run_reservations` (`project_id`,`created_at`);