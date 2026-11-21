CREATE TABLE `google_drive_archive_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`google_account_id` text NOT NULL,
	`account_email` text NOT NULL,
	`access_token_ciphertext` text NOT NULL,
	`refresh_token_ciphertext` text NOT NULL,
	`access_token_expires_at` text NOT NULL,
	`scope` text NOT NULL,
	`folder_id` text,
	`folder_name` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connected_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_drive_archive_connections_organization_idx` ON `google_drive_archive_connections` (`organization_id`);--> statement-breakpoint
CREATE INDEX `google_drive_archive_connections_account_idx` ON `google_drive_archive_connections` (`google_account_id`);