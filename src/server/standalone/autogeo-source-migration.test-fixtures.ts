import type { AutoGeoMapping } from "./autogeo-source-adapter-schema";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";
import type { AutoGeoSourceArchivePort } from "./autogeo-source-archive";
import type {
  AutoGeoSourceMigrationOutboxPort,
  AutoGeoSourceMigrationOutboxRecord,
} from "./autogeo-source-migration";

const at = "2026-11-16T10:00:00.000Z";
const jsonlBytes = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

export function syntheticSourceArtifacts() {
  return {
    "prompts/matrix-v1.jsonl": jsonlBytes({
      id: "prompt-auto-1",
      locale: "en",
      intent_category: "product_research",
      pair_id: null,
      entities: ["Example"],
      translation_of: null,
      text: "What is Example?",
    }),
    "runs/run-auto-1/answers.jsonl": jsonlBytes({
      answer_id: "answer-auto-1",
      run_id: "run-auto-1",
      prompt_id: "prompt-auto-1",
      intent_category: "product_research",
      locale: "en",
      provider: "provider-a",
      model_id: "model-a",
      model_snapshot_date: "2026-10-01",
      requested_at: "2026-10-01T10:00:00.000Z",
      status: "ok",
      answer_text: "Synthetic historical answer.",
      citations: ["https://example.test/source"],
      error: null,
    }),
  };
}

export function reviewedMapping(): AutoGeoMapping {
  return {
    clientRef: "synthetic-auto-client",
    mappingEvidenceRef: "review/4-3/synthetic-map-2",
    sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
    exportedAt: at,
    projects: [
      {
        id: "project-auto",
        name: "Synthetic AutoGeo project",
        domain: "example.test",
        locationCode: 2840,
        languageCode: "en",
        createdAt: at,
        archivedAt: null,
        aiResearchKeywords: null,
      },
    ],
    trackers: [
      {
        id: "tracker-auto",
        projectId: "project-auto",
        locationCode: 2840,
        languageCode: "en",
        scheduleInterval: "weekly",
        createdAt: at,
      },
    ],
    promptMappings: {
      "v1:prompt-auto-1": {
        id: "mapped-prompt-auto-1",
        trackerId: "tracker-auto",
        topic: "Product research",
        createdAt: at,
      },
    },
    runMappings: {
      "run-auto-1": {
        trackerId: "tracker-auto",
        projectId: "project-auto",
        trigger: "scheduled",
        status: "completed",
        locationCode: 2840,
        languageCode: "en",
        createdAt: at,
        completedAt: at,
      },
    },
    answerMappings: {
      "run-auto-1:answer-auto-1": {
        sourceStatus: "ok",
        sourceProvider: "provider-a",
        engine: "chatgpt",
        resultStatus: "completed",
        collectedAt: "2026-10-01T10:01:00.000Z",
        confirmedCitationIndexes: [0],
      },
    },
  };
}

function migrationApproval(
  mapping: AutoGeoMapping,
  targetOrganizationId: string,
) {
  const approvedAt = "2026-11-22T10:00:00.000Z";
  return {
    status: "approved" as const,
    clientRef: mapping.clientRef,
    targetOrganizationId,
    sourceContractRevision: mapping.sourceContractRevision,
    mappingEvidenceRef: mapping.mappingEvidenceRef,
    sourceReadEvidenceRef: "synthetic-evidence:source-rights",
    targetWriteEvidenceRef: "synthetic-evidence:target-rights",
    archiveDestinationEvidenceRef: "synthetic-evidence:archive-rights",
    retentionEvidenceRef: "synthetic-evidence:source-retention",
    restoreEvidenceRef: "synthetic-evidence:restore-check",
    approvedBy: "synthetic-reviewer",
    approvedAt,
    expiresAt: new Date(Date.parse(approvedAt) + 60 * 60 * 1000).toISOString(),
  };
}

export function migrationHarness(options?: {
  deny?: boolean;
  failDriveWrite?: boolean;
  expiredApproval?: boolean;
}) {
  const events: string[] = [];
  const outboxRecords = new Map<string, AutoGeoSourceMigrationOutboxRecord>();
  const remoteArchives = new Map<
    string,
    { fileId: string; envelope: AutoGeoSourceMigrationOutboxRecord["envelope"] }
  >();
  const outbox: AutoGeoSourceMigrationOutboxPort = {
    async putIfAbsent(record) {
      events.push("outbox-persist");
      const key = `${record.clientRef}:${record.idempotencyKey}`;
      const previous = outboxRecords.get(key);
      if (!previous) {
        outboxRecords.set(key, record);
        return record;
      }
      if (previous.artifactsFingerprint !== record.artifactsFingerprint)
        throw new Error("synthetic idempotency conflict");
      return previous;
    },
    async reserveArchiveFileId(record, candidate) {
      const key = `${record.clientRef}:${record.idempotencyKey}`;
      const saved = outboxRecords.get(key);
      if (!saved) throw new Error("synthetic outbox record not found");
      if (
        candidate.archiveTarget.organizationId !== record.targetOrganizationId
      )
        throw new Error("synthetic archive target mismatch");
      if (saved.archiveFileId) {
        if (
          saved.archiveTarget?.organizationId !==
            candidate.archiveTarget.organizationId ||
          saved.archiveTarget.folderId !== candidate.archiveTarget.folderId
        )
          throw new Error("synthetic archive target changed");
        return saved;
      }
      const reserved = {
        ...saved,
        archiveFileId: candidate.archiveFileId,
        archiveTarget: candidate.archiveTarget,
      };
      outboxRecords.set(key, reserved);
      events.push("outbox-archive-id-reserved");
      return reserved;
    },
    async markArchived(record, fileId) {
      const key = `${record.clientRef}:${record.idempotencyKey}`;
      const saved = outboxRecords.get(key);
      if (!saved) return false;
      if (saved.archiveFileId && saved.archiveFileId !== fileId) return false;
      outboxRecords.set(key, { ...saved, archiveFileId: fileId });
      events.push("outbox-archive-confirmed");
      return true;
    },
  };
  const archive: AutoGeoSourceArchivePort = {
    async generateFileId(organizationId) {
      events.push("drive-id-generate");
      if (organizationId !== "target-a")
        throw new Error("synthetic archive target mismatch");
      return {
        fileId: "synthetic-drive-file-1",
        target: {
          connectionId: "synthetic-connection",
          organizationId,
          googleAccountId: "synthetic-google-account",
          folderId: "synthetic-folder",
        },
      };
    },
    async putEncryptedSourceArchive(envelope, fileId) {
      events.push("drive-write");
      if (options?.failDriveWrite) throw new Error("synthetic write failure");
      const key = `${envelope.clientRef}:${envelope.idempotencyKey}`;
      const existing = remoteArchives.get(key);
      if (
        existing &&
        (existing.envelope.ciphertext.some(
          (byte, index) => byte !== envelope.ciphertext[index],
        ) ||
          existing.envelope.iv.some(
            (byte, index) => byte !== envelope.iv[index],
          ))
      )
        throw new Error("synthetic archive idempotency conflict");
      const storedFileId = existing?.fileId ?? fileId;
      remoteArchives.set(key, {
        fileId: storedFileId,
        envelope: {
          ...envelope,
          iv: envelope.iv.slice(),
          ciphertext: envelope.ciphertext.slice(),
        },
      });
      return { fileId: storedFileId };
    },
    async readEncryptedSourceArchive(clientRef, idempotencyKey, fileId) {
      events.push("drive-readback");
      const saved = remoteArchives.get(`${clientRef}:${idempotencyKey}`);
      if (saved && saved.fileId !== fileId)
        throw new Error("synthetic archive ID mismatch");
      return saved
        ? {
            fileId: saved.fileId,
            envelope: {
              ...saved.envelope,
              iv: saved.envelope.iv.slice(),
              ciphertext: saved.envelope.ciphertext.slice(),
            },
          }
        : null;
    },
  };
  return {
    events,
    outboxRecords,
    remoteArchives,
    outbox,
    archive,
    authorization: {
      async authorize({
        clientRef,
        targetOrganizationId,
        mapping,
      }: {
        clientRef: string;
        targetOrganizationId: string;
        mapping: AutoGeoMapping;
      }) {
        events.push("authorization");
        if (
          options?.deny ||
          clientRef !== mapping.clientRef ||
          targetOrganizationId !== "target-a"
        )
          return { status: "denied" };
        const approval = migrationApproval(mapping, targetOrganizationId);
        return options?.expiredApproval
          ? { ...approval, expiresAt: "2026-11-22T09:59:59.000Z" }
          : approval;
      },
    },
  };
}

export { jsonlBytes };
