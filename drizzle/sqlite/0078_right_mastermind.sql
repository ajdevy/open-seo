CREATE TABLE `autogeo_source_migration_outbox_chunks` (
	`storage_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`ciphertext_base64` text NOT NULL,
	PRIMARY KEY(`storage_id`, `chunk_index`),
	FOREIGN KEY (`storage_id`) REFERENCES `autogeo_source_migration_outbox`(`encrypted_envelope_storage_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
ALTER TABLE `autogeo_source_migration_outbox` ADD `encrypted_envelope_storage_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `autogeo_source_migration_outbox_envelope_storage_idx` ON `autogeo_source_migration_outbox` (`encrypted_envelope_storage_id`);