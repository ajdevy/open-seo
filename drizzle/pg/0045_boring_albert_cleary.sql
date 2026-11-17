CREATE TABLE "google_drive_archive_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"google_account_id" text NOT NULL,
	"account_email" text NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"access_token_expires_at" text NOT NULL,
	"scope" text NOT NULL,
	"folder_id" text,
	"folder_name" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_drive_archive_connections" ADD CONSTRAINT "google_drive_archive_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_drive_archive_connections" ADD CONSTRAINT "google_drive_archive_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_drive_archive_connections_organization_idx" ON "google_drive_archive_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "google_drive_archive_connections_account_idx" ON "google_drive_archive_connections" USING btree ("google_account_id");