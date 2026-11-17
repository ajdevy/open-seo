CREATE TABLE `project_settings_snapshot_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`algorithm` text NOT NULL,
	`schema_version` integer NOT NULL,
	`iv` text NOT NULL,
	`ciphertext` text NOT NULL,
	`status` text DEFAULT 'unconfirmed' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`confirmed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_settings_snapshot_outbox_revision_idx` ON `project_settings_snapshot_outbox` (`project_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_settings_snapshot_outbox_idempotency_idx` ON `project_settings_snapshot_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `project_settings_snapshot_outbox_status_idx` ON `project_settings_snapshot_outbox` (`status`,`project_id`,`revision`);--> statement-breakpoint
CREATE TABLE `project_settings_snapshot_revisions` (
	`project_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
