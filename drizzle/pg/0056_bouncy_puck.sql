ALTER TABLE "autogeo_source_migration_outbox" ADD COLUMN "encrypted_envelope_storage_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "autogeo_source_migration_outbox_envelope_storage_idx" ON "autogeo_source_migration_outbox" USING btree ("encrypted_envelope_storage_id");
--> statement-breakpoint
CREATE TABLE "autogeo_source_migration_outbox_chunks" (
	"storage_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"ciphertext_base64" text NOT NULL,
	CONSTRAINT "autogeo_source_migration_outbox_chunks_storage_id_chunk_index_pk" PRIMARY KEY("storage_id","chunk_index"),
	CONSTRAINT "autogeo_source_migration_outbox_chunks_storage_fk" FOREIGN KEY ("storage_id") REFERENCES "public"."autogeo_source_migration_outbox"("encrypted_envelope_storage_id") ON DELETE restrict ON UPDATE no action
);
