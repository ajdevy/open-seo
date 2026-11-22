import {
  mappingApprovalSchema,
  mappingSchema,
  type AutoGeoMapping,
} from "./autogeo-source-adapter-schema";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";

const DIGEST_REF_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const BINDING_PATTERN =
  /^autogeo-evidence-v1:([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/u;

export type AutoGeoMigrationEvidence = {
  clientRef: string;
  targetOrganizationId: string;
  sourceContractRevision: typeof AUTOGEO_SOURCE_CONTRACT_REVISION;
  sourceReadEvidenceRef: string;
  targetWriteEvidenceRef: string;
  archiveDestinationEvidenceRef: string;
  retentionEvidenceRef: string;
  restoreEvidenceRef: string;
  expiresAt: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    // oxlint-disable-next-line unicorn/no-array-sort
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function mappingWithoutBinding(
  value: unknown,
): Omit<AutoGeoMapping, "mappingEvidenceRef"> {
  const full = mappingSchema.safeParse(value);
  if (full.success) {
    const { mappingEvidenceRef: _mappingEvidenceRef, ...mapping } = full.data;
    return mapping;
  }
  return mappingApprovalSchema.parse(value);
}

export async function fingerprintAutoGeoMapping(
  value: unknown,
): Promise<string> {
  return sha256Hex(stableJson(mappingWithoutBinding(value)));
}

function digestFromRef(value: string): string {
  const match = DIGEST_REF_PATTERN.exec(value);
  if (!match)
    throw new Error("Migration evidence references must be SHA-256 digests.");
  return match[1];
}

function evidenceBundle(
  value: AutoGeoMigrationEvidence & {
    mappingEvidenceRef: string;
    sourceArtifactsFingerprint: string;
  },
): string {
  return stableJson({
    clientRef: value.clientRef,
    targetOrganizationId: value.targetOrganizationId,
    sourceContractRevision: value.sourceContractRevision,
    mappingEvidenceRef: value.mappingEvidenceRef,
    sourceArtifactsFingerprint: value.sourceArtifactsFingerprint,
    sourceReadEvidenceRef: value.sourceReadEvidenceRef,
    targetWriteEvidenceRef: value.targetWriteEvidenceRef,
    archiveDestinationEvidenceRef: value.archiveDestinationEvidenceRef,
    retentionEvidenceRef: value.retentionEvidenceRef,
    restoreEvidenceRef: value.restoreEvidenceRef,
    expiresAt: value.expiresAt,
  });
}

export async function createAutoGeoMigrationEvidenceBinding(input: {
  mapping: unknown;
  sourceArtifactsFingerprint: string;
  evidence: AutoGeoMigrationEvidence;
}): Promise<string> {
  const mappingFingerprint = await fingerprintAutoGeoMapping(input.mapping);
  const mappingEvidenceRef = `sha256:${mappingFingerprint}`;
  const sourceArtifactsDigest = digestFromRef(input.sourceArtifactsFingerprint);
  for (const reference of [
    input.evidence.sourceReadEvidenceRef,
    input.evidence.targetWriteEvidenceRef,
    input.evidence.archiveDestinationEvidenceRef,
    input.evidence.retentionEvidenceRef,
    input.evidence.restoreEvidenceRef,
  ])
    digestFromRef(reference);

  const bundleFingerprint = await sha256Hex(
    evidenceBundle({
      ...input.evidence,
      mappingEvidenceRef,
      sourceArtifactsFingerprint: `sha256:${sourceArtifactsDigest}`,
    }),
  );
  return `autogeo-evidence-v1:${mappingFingerprint}:${sourceArtifactsDigest}:${bundleFingerprint}`;
}

export async function verifyAutoGeoMigrationEvidenceBinding(
  approval: AutoGeoMigrationEvidence & { mappingEvidenceRef: string },
  mapping: AutoGeoMapping,
  sourceArtifactsFingerprint?: string,
): Promise<boolean> {
  const match = BINDING_PATTERN.exec(approval.mappingEvidenceRef);
  if (!match) return false;
  const [, mappingFingerprint, sourceArtifactsDigest] = match;
  if ((await fingerprintAutoGeoMapping(mapping)) !== mappingFingerprint)
    return false;
  if (
    sourceArtifactsFingerprint !== undefined &&
    sourceArtifactsFingerprint !== `sha256:${sourceArtifactsDigest}`
  )
    return false;

  try {
    const expected = await createAutoGeoMigrationEvidenceBinding({
      mapping,
      sourceArtifactsFingerprint: `sha256:${sourceArtifactsDigest}`,
      evidence: {
        ...approval,
        sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
      },
    });
    return expected === approval.mappingEvidenceRef;
  } catch {
    return false;
  }
}

export function isSha256EvidenceRef(value: string): boolean {
  return DIGEST_REF_PATTERN.test(value);
}
