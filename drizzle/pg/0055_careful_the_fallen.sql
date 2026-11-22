CREATE TABLE "autogeo_source_migration_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"client_ref" text NOT NULL,
	"target_organization_id" text NOT NULL,
	"source_contract_revision" text NOT NULL,
	"mapping_evidence_ref" text NOT NULL,
	"source_read_evidence_ref" text NOT NULL,
	"target_write_evidence_ref" text NOT NULL,
	"archive_destination_evidence_ref" text NOT NULL,
	"retention_evidence_ref" text NOT NULL,
	"restore_evidence_ref" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"revoked_at" text,
	"revocation_evidence_ref" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "autogeo_source_migration_approvals_active_idx" ON "autogeo_source_migration_approvals" USING btree ("client_ref","target_organization_id","source_contract_revision","mapping_evidence_ref") WHERE "autogeo_source_migration_approvals"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "autogeo_source_migration_approvals_expiry_idx" ON "autogeo_source_migration_approvals" USING btree ("status","expires_at");