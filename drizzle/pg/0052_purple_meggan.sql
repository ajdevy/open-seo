CREATE TABLE "autogeo_source_migration_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"client_ref" text NOT NULL,
	"target_organization_id" text NOT NULL,
	"source_contract_revision" text NOT NULL,
	"mapping_evidence_ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"artifacts_fingerprint" text NOT NULL,
	"encrypted_envelope" text NOT NULL,
	"archive_file_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"archived_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "autogeo_source_migration_outbox_client_idempotency_idx" ON "autogeo_source_migration_outbox" USING btree ("client_ref","idempotency_key");--> statement-breakpoint
CREATE INDEX "autogeo_source_migration_outbox_status_created_idx" ON "autogeo_source_migration_outbox" USING btree ("status","created_at");