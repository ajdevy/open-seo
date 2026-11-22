import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { autoGeoSourceMigrationApprovals, organization } from "@/db/schema";
import type {
  AutoGeoMigrationApproval,
  AutoGeoSourceMigrationAuthorizationPort,
} from "./autogeo-source-migration";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";

const MAX_APPROVAL_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const OPERATOR_PRINCIPAL = "standalone-operator";

export type AutoGeoSourceMigrationApprovalEvidence = {
  clientRef: string;
  targetOrganizationId: string;
  sourceContractRevision: AutoGeoMigrationApproval["sourceContractRevision"];
  mappingEvidenceRef: string;
  sourceReadEvidenceRef: string;
  targetWriteEvidenceRef: string;
  archiveDestinationEvidenceRef: string;
  retentionEvidenceRef: string;
  restoreEvidenceRef: string;
  expiresAt: string;
};

function approvalFromRow(
  row: typeof autoGeoSourceMigrationApprovals.$inferSelect,
): AutoGeoMigrationApproval {
  return {
    status: "approved",
    clientRef: row.clientRef,
    targetOrganizationId: row.targetOrganizationId,
    sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
    mappingEvidenceRef: row.mappingEvidenceRef,
    sourceReadEvidenceRef: row.sourceReadEvidenceRef,
    targetWriteEvidenceRef: row.targetWriteEvidenceRef,
    archiveDestinationEvidenceRef: row.archiveDestinationEvidenceRef,
    retentionEvidenceRef: row.retentionEvidenceRef,
    restoreEvidenceRef: row.restoreEvidenceRef,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    expiresAt: row.expiresAt,
  };
}

export async function createAutoGeoSourceMigrationApproval(
  evidence: AutoGeoSourceMigrationApprovalEvidence,
  now: Date = new Date(),
): Promise<{ approvalId: string; approvedAt: string }> {
  const approvedAt = now.toISOString();
  const expiresAt = Date.parse(evidence.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now.getTime() ||
    expiresAt > now.getTime() + MAX_APPROVAL_AGE_MS
  )
    throw new Error("Approval expiry must be within the next 30 days.");

  const [target] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, evidence.targetOrganizationId))
    .limit(1);
  if (!target) throw new Error("Target organization does not exist.");

  // Expired rows remain in the audit history, but no longer occupy the active
  // unique key. The partial unique index remains the final concurrency guard.
  await db
    .update(autoGeoSourceMigrationApprovals)
    .set({ status: "expired", revokedAt: approvedAt })
    .where(
      and(
        eq(autoGeoSourceMigrationApprovals.clientRef, evidence.clientRef),
        eq(
          autoGeoSourceMigrationApprovals.targetOrganizationId,
          evidence.targetOrganizationId,
        ),
        eq(
          autoGeoSourceMigrationApprovals.sourceContractRevision,
          evidence.sourceContractRevision,
        ),
        eq(
          autoGeoSourceMigrationApprovals.mappingEvidenceRef,
          evidence.mappingEvidenceRef,
        ),
        eq(autoGeoSourceMigrationApprovals.status, "approved"),
        lte(autoGeoSourceMigrationApprovals.expiresAt, approvedAt),
      ),
    );

  const activeApprovalWhere = and(
    eq(autoGeoSourceMigrationApprovals.clientRef, evidence.clientRef),
    eq(
      autoGeoSourceMigrationApprovals.targetOrganizationId,
      evidence.targetOrganizationId,
    ),
    eq(
      autoGeoSourceMigrationApprovals.sourceContractRevision,
      evidence.sourceContractRevision,
    ),
    eq(
      autoGeoSourceMigrationApprovals.mappingEvidenceRef,
      evidence.mappingEvidenceRef,
    ),
    eq(autoGeoSourceMigrationApprovals.status, "approved"),
  );
  const [activeApproval] = await db
    .select({ id: autoGeoSourceMigrationApprovals.id })
    .from(autoGeoSourceMigrationApprovals)
    .where(activeApprovalWhere)
    .limit(1);
  if (activeApproval) throw new Error("An active approval already exists.");

  const approvalId = crypto.randomUUID();
  try {
    await db.insert(autoGeoSourceMigrationApprovals).values({
      id: approvalId,
      ...evidence,
      approvedBy: OPERATOR_PRINCIPAL,
      approvedAt,
      status: "approved",
    });
  } catch (error) {
    const [concurrentApproval] = await db
      .select({ id: autoGeoSourceMigrationApprovals.id })
      .from(autoGeoSourceMigrationApprovals)
      .where(activeApprovalWhere)
      .limit(1);
    if (concurrentApproval)
      throw new Error("An active approval already exists.", { cause: error });
    throw error;
  }
  return { approvalId, approvedAt };
}

export async function revokeAutoGeoSourceMigrationApproval(
  approvalId: string,
  evidenceRef: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(autoGeoSourceMigrationApprovals)
    .set({
      status: "revoked",
      revokedAt: now.toISOString(),
      revocationEvidenceRef: evidenceRef,
    })
    .where(
      and(
        eq(autoGeoSourceMigrationApprovals.id, approvalId),
        eq(autoGeoSourceMigrationApprovals.status, "approved"),
      ),
    )
    .returning({ id: autoGeoSourceMigrationApprovals.id });
  return rows.length === 1;
}

export const autoGeoSourceMigrationAuthorization: AutoGeoSourceMigrationAuthorizationPort =
  {
    async authorize(input) {
      const now = new Date().toISOString();
      const [row] = await db
        .select()
        .from(autoGeoSourceMigrationApprovals)
        .where(
          and(
            eq(autoGeoSourceMigrationApprovals.clientRef, input.clientRef),
            eq(
              autoGeoSourceMigrationApprovals.targetOrganizationId,
              input.targetOrganizationId,
            ),
            eq(
              autoGeoSourceMigrationApprovals.sourceContractRevision,
              input.mapping.sourceContractRevision,
            ),
            eq(
              autoGeoSourceMigrationApprovals.mappingEvidenceRef,
              input.mapping.mappingEvidenceRef,
            ),
            eq(autoGeoSourceMigrationApprovals.status, "approved"),
            isNull(autoGeoSourceMigrationApprovals.revokedAt),
            lte(autoGeoSourceMigrationApprovals.approvedAt, now),
            gt(autoGeoSourceMigrationApprovals.expiresAt, now),
          ),
        )
        .limit(1);
      return row ? approvalFromRow(row) : null;
    },
  };
