import { z } from "zod";
import { importClientRestoreArchive } from "./client-restore-import";
import {
  mappingSchema,
  type AutoGeoMapping,
} from "./autogeo-source-adapter-schema";
import {
  AUTOGEO_SOURCE_CONTRACT_REVISION,
  type AutoGeoRestorePlan,
  prepareAutoGeoClientRestore,
} from "./autogeo-source-adapter";
import {
  deliverEncryptedAutoGeoSourceArchive,
  fingerprintAutoGeoSourceArtifacts,
  prepareEncryptedAutoGeoSourceArchive,
  type AutoGeoSourceArchivePort,
  type EncryptedAutoGeoSourceArchive,
} from "./autogeo-source-archive";

const evidenceRefSchema = z.string().trim().min(1).max(240);
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);

const approvalSchema = z
  .object({
    status: z.literal("approved"),
    clientRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    targetOrganizationId: z.string().trim().min(1).max(200),
    sourceContractRevision: z.literal(AUTOGEO_SOURCE_CONTRACT_REVISION),
    mappingEvidenceRef: evidenceRefSchema,
    sourceReadEvidenceRef: evidenceRefSchema,
    targetWriteEvidenceRef: evidenceRefSchema,
    archiveDestinationEvidenceRef: evidenceRefSchema,
    retentionEvidenceRef: evidenceRefSchema,
    restoreEvidenceRef: evidenceRefSchema,
    approvedBy: z.string().trim().min(1).max(200),
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type AutoGeoMigrationApproval = z.infer<typeof approvalSchema>;

export type AutoGeoSourceMigrationOutboxRecord = {
  clientRef: string;
  targetOrganizationId: string;
  sourceContractRevision: typeof AUTOGEO_SOURCE_CONTRACT_REVISION;
  mappingEvidenceRef: string;
  idempotencyKey: string;
  artifactsFingerprint: string;
  envelope: EncryptedAutoGeoSourceArchive;
};

export interface AutoGeoSourceMigrationOutboxPort {
  /**
   * Persist the complete encrypted envelope atomically before any network
   * delivery. For the same client and idempotency key, return the original
   * envelope only when all binding metadata and the plaintext fingerprint
   * match; otherwise reject the conflicting retry.
   */
  putIfAbsent(
    record: AutoGeoSourceMigrationOutboxRecord,
  ): Promise<AutoGeoSourceMigrationOutboxRecord>;
}

export interface AutoGeoSourceMigrationAuthorizationPort {
  /**
   * Resolve evidence from trusted per-client authorization records. The
   * implementation must verify source-read, target-write, archive-destination,
   * retention, restore, and reviewed field-map evidence before approving.
   */
  authorize(input: {
    clientRef: string;
    targetOrganizationId: string;
    mapping: AutoGeoMapping;
  }): Promise<unknown>;
}

export interface AutoGeoSourceMigrationInput {
  targetOrganizationId: string;
  idempotencyKey: string;
  mapping: unknown;
  readSourceArtifacts(
    approval: AutoGeoMigrationApproval,
  ): Promise<Record<string, Uint8Array>>;
  authorization: AutoGeoSourceMigrationAuthorizationPort;
  outbox: AutoGeoSourceMigrationOutboxPort;
  archiveKey: CryptoKey;
  archivePort: AutoGeoSourceArchivePort;
}

export type AutoGeoSourceMigrationResult =
  | {
      status: "blocked";
      reason:
        | "invalid_mapping"
        | "invalid_migration_request"
        | "authorization_required";
    }
  | {
      status: "archived_unimported";
      reason: "incomplete_source_mapping";
      report: AutoGeoRestorePlan["report"];
      archiveFileId: string;
    }
  | {
      status: "archive_pending";
      reason:
        | "outbox_unconfirmed"
        | "drive_write_unconfirmed"
        | "drive_readback_unconfirmed";
      report: AutoGeoRestorePlan["report"];
      archiveFileId?: string;
    }
  | {
      status: "import_unconfirmed";
      reason: "target_readback_failed";
      report: AutoGeoRestorePlan["report"];
      archiveFileId: string;
    }
  | {
      status: "imported";
      report: AutoGeoRestorePlan["report"];
      archiveFileId: string;
      importedProjectIds: string[];
      importedContentSha256: string;
    };

function approvalMatches(
  approval: AutoGeoMigrationApproval,
  mapping: AutoGeoMapping,
  targetOrganizationId: string,
  now: Date,
): boolean {
  const approvedAt = Date.parse(approval.approvedAt);
  const expiresAt = Date.parse(approval.expiresAt);
  return (
    approval.clientRef === mapping.clientRef &&
    approval.targetOrganizationId === targetOrganizationId &&
    approval.sourceContractRevision === mapping.sourceContractRevision &&
    approval.mappingEvidenceRef === mapping.mappingEvidenceRef &&
    Number.isFinite(approvedAt) &&
    Number.isFinite(expiresAt) &&
    approvedAt <= now.getTime() &&
    expiresAt > now.getTime()
  );
}

function outboxRecordMatches(
  record: AutoGeoSourceMigrationOutboxRecord,
  expected: AutoGeoSourceMigrationOutboxRecord,
): boolean {
  return (
    record.clientRef === expected.clientRef &&
    record.targetOrganizationId === expected.targetOrganizationId &&
    record.sourceContractRevision === expected.sourceContractRevision &&
    record.mappingEvidenceRef === expected.mappingEvidenceRef &&
    record.idempotencyKey === expected.idempotencyKey &&
    record.artifactsFingerprint === expected.artifactsFingerprint &&
    record.envelope.clientRef === expected.clientRef &&
    record.envelope.sourceContractRevision ===
      expected.sourceContractRevision &&
    record.envelope.idempotencyKey === expected.idempotencyKey
  );
}

/**
 * Run a reviewed AutoGeo migration only after trusted per-client evidence is
 * verified. It reads source artifacts after authorization, atomically persists
 * the exact encrypted envelope before Drive delivery, and imports only after
 * encrypted read-back succeeds. The caller must retain the source until its
 * own post-migration acceptance is complete.
 */
export async function runAutoGeoSourceMigration(
  input: AutoGeoSourceMigrationInput,
  now: () => Date = () => new Date(),
): Promise<AutoGeoSourceMigrationResult> {
  const mappingResult = mappingSchema.safeParse(input.mapping);
  if (!mappingResult.success)
    return { status: "blocked", reason: "invalid_mapping" };
  if (
    !z.string().trim().min(1).max(200).safeParse(input.targetOrganizationId)
      .success ||
    !idempotencyKeySchema.safeParse(input.idempotencyKey).success
  )
    return { status: "blocked", reason: "invalid_migration_request" };
  const mapping = mappingResult.data;

  let approvalResult: unknown;
  try {
    approvalResult = await input.authorization.authorize({
      clientRef: mapping.clientRef,
      targetOrganizationId: input.targetOrganizationId,
      mapping,
    });
  } catch {
    return { status: "blocked", reason: "authorization_required" };
  }
  const approval = approvalSchema.safeParse(approvalResult);
  if (
    !approval.success ||
    !approvalMatches(approval.data, mapping, input.targetOrganizationId, now())
  )
    return { status: "blocked", reason: "authorization_required" };

  const artifacts = await input.readSourceArtifacts(approval.data);
  const plan = await prepareAutoGeoClientRestore(artifacts, mapping);
  const importEligible =
    plan.report.blockers.length === 0 && plan.archive !== null;

  const artifactsFingerprint = await fingerprintAutoGeoSourceArtifacts(
    plan.archiveArtifacts,
  );
  const candidateEnvelope = await prepareEncryptedAutoGeoSourceArchive(
    {
      clientRef: mapping.clientRef,
      sourceContractRevision: mapping.sourceContractRevision,
      idempotencyKey: input.idempotencyKey,
      artifacts: plan.archiveArtifacts,
    },
    input.archiveKey,
  );
  const expectedRecord: AutoGeoSourceMigrationOutboxRecord = {
    clientRef: mapping.clientRef,
    targetOrganizationId: input.targetOrganizationId,
    sourceContractRevision: mapping.sourceContractRevision,
    mappingEvidenceRef: mapping.mappingEvidenceRef,
    idempotencyKey: input.idempotencyKey,
    artifactsFingerprint,
    envelope: candidateEnvelope,
  };

  let persistedRecord: AutoGeoSourceMigrationOutboxRecord;
  try {
    persistedRecord = await input.outbox.putIfAbsent(expectedRecord);
  } catch {
    return {
      status: "archive_pending",
      reason: "outbox_unconfirmed",
      report: plan.report,
    };
  }
  if (!outboxRecordMatches(persistedRecord, expectedRecord))
    return {
      status: "archive_pending",
      reason: "outbox_unconfirmed",
      report: plan.report,
    };

  const delivery = await deliverEncryptedAutoGeoSourceArchive(
    persistedRecord.envelope,
    input.archiveKey,
    input.archivePort,
  );
  if (delivery.status !== "confirmed")
    return {
      status: "archive_pending",
      reason:
        delivery.reason === "write_unconfirmed"
          ? "drive_write_unconfirmed"
          : "drive_readback_unconfirmed",
      report: plan.report,
      ...(delivery.fileId ? { archiveFileId: delivery.fileId } : {}),
    };

  // Unsupported or incompletely mapped source rows remain recoverable in the
  // verified private archive. They are never turned into partial OpenSEO data.
  if (!importEligible)
    return {
      status: "archived_unimported",
      reason: "incomplete_source_mapping",
      report: plan.report,
      archiveFileId: delivery.fileId,
    };

  let imported: Awaited<ReturnType<typeof importClientRestoreArchive>>;
  try {
    imported = await importClientRestoreArchive(
      input.targetOrganizationId,
      plan.archive,
    );
  } catch {
    return {
      status: "import_unconfirmed",
      reason: "target_readback_failed",
      report: plan.report,
      archiveFileId: delivery.fileId,
    };
  }
  if (!imported.verified)
    return {
      status: "import_unconfirmed",
      reason: "target_readback_failed",
      report: plan.report,
      archiveFileId: delivery.fileId,
    };
  return {
    status: "imported",
    report: plan.report,
    archiveFileId: delivery.fileId,
    importedProjectIds: imported.importedProjectIds,
    importedContentSha256: imported.importedContentSha256,
  };
}
