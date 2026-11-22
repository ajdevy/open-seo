import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const { testDb } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } =
    await import("@/server/features/ai-visibility/aiVisibilityTestDb");
  return { testDb: await createAiVisibilityTestDb() };
});

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: testDb.db }));

import { db } from "@/db";
import { autoGeoSourceMigrationApprovals } from "@/db/schema";
import type { AutoGeoMapping } from "./autogeo-source-adapter-schema";
import {
  autoGeoSourceMigrationAuthorization,
  createAutoGeoSourceMigrationApproval,
  revokeAutoGeoSourceMigrationApproval,
} from "./autogeo-source-migration-approval";
import type { AutoGeoSourceMigrationApprovalEvidence } from "./autogeo-source-migration-approval";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";
import { reviewedMapping } from "./autogeo-source-migration.test-fixtures";

function approvalInput(
  overrides: Partial<
    Pick<
      AutoGeoSourceMigrationApprovalEvidence,
      "clientRef" | "expiresAt" | "sourceReadEvidenceRef"
    >
  > = {},
): AutoGeoSourceMigrationApprovalEvidence {
  const { mappingEvidenceRef: _mappingEvidenceRef, ...originalMapping } =
    reviewedMapping();
  const mapping = {
    ...originalMapping,
    ...(typeof overrides.clientRef === "string"
      ? { clientRef: overrides.clientRef }
      : {}),
  };
  return {
    clientRef: mapping.clientRef,
    targetOrganizationId: "organization",
    sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
    mapping,
    sourceArtifactsFingerprint: `sha256:${"f".repeat(64)}`,
    sourceReadEvidenceRef: `sha256:${"a".repeat(64)}`,
    targetWriteEvidenceRef: `sha256:${"b".repeat(64)}`,
    archiveDestinationEvidenceRef: `sha256:${"c".repeat(64)}`,
    retentionEvidenceRef: `sha256:${"d".repeat(64)}`,
    restoreEvidenceRef: `sha256:${"e".repeat(64)}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    ...overrides,
  };
}

describe("AutoGeo per-client migration approvals", () => {
  afterAll(() => testDb.client.close());

  it("rejects non-digest evidence references before creating an approval", async () => {
    const input = approvalInput({
      sourceReadEvidenceRef: "evidence/source-rights",
    });

    await expect(createAutoGeoSourceMigrationApproval(input)).rejects.toThrow(
      "Migration evidence references must be SHA-256 digests.",
    );
  });

  it("requires exact client, target, contract and mapping evidence and supports revocation", async () => {
    await testDb.seedProject();
    const input: AutoGeoSourceMigrationApprovalEvidence = approvalInput({
      clientRef: `synthetic-client-${crypto.randomUUID()}`,
    });
    const created = await createAutoGeoSourceMigrationApproval(input);
    const { mappingEvidenceRef: _mappingEvidenceRef, ...mappingBase } =
      reviewedMapping();
    const mapping: AutoGeoMapping = {
      ...mappingBase,
      clientRef: input.clientRef,
      mappingEvidenceRef: created.mappingEvidenceRef,
    };

    await expect(
      autoGeoSourceMigrationAuthorization.authorize({
        clientRef: input.clientRef,
        targetOrganizationId: input.targetOrganizationId,
        mapping,
      }),
    ).resolves.toMatchObject({
      status: "approved",
      clientRef: input.clientRef,
      targetOrganizationId: input.targetOrganizationId,
      approvedBy: "operator-secret-authenticated",
    });
    await expect(
      autoGeoSourceMigrationAuthorization.authorize({
        clientRef: input.clientRef,
        targetOrganizationId: "other-organization",
        mapping,
      }),
    ).resolves.toBeNull();
    await expect(
      autoGeoSourceMigrationAuthorization.authorize({
        clientRef: input.clientRef,
        targetOrganizationId: input.targetOrganizationId,
        mapping: {
          ...mapping,
          projects: mapping.projects.map((project) => ({
            ...project,
            name: "Different map content",
          })),
        },
      }),
    ).resolves.toBeNull();

    expect(
      await revokeAutoGeoSourceMigrationApproval(
        created.approvalId,
        "evidence/revoked-by-client",
      ),
    ).toBe(true);
    await expect(
      autoGeoSourceMigrationAuthorization.authorize({
        clientRef: input.clientRef,
        targetOrganizationId: input.targetOrganizationId,
        mapping,
      }),
    ).resolves.toBeNull();
    const [row] = await db
      .select()
      .from(autoGeoSourceMigrationApprovals)
      .where(eq(autoGeoSourceMigrationApprovals.id, created.approvalId));
    expect(row).toMatchObject({
      status: "revoked",
      revocationEvidenceRef: "evidence/revoked-by-client",
    });
  });

  it("rejects missing targets, expired evidence and duplicate active approvals", async () => {
    await testDb.seedProject();
    const input: AutoGeoSourceMigrationApprovalEvidence = approvalInput({
      clientRef: `synthetic-client-${crypto.randomUUID()}`,
    });
    await expect(
      createAutoGeoSourceMigrationApproval({
        ...input,
        targetOrganizationId: "missing-organization",
      }),
    ).rejects.toThrow("Target organization does not exist");
    await expect(
      createAutoGeoSourceMigrationApproval({
        ...input,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ).rejects.toThrow("Approval expiry must be within the next 30 days");

    const first = await createAutoGeoSourceMigrationApproval(input);
    await expect(createAutoGeoSourceMigrationApproval(input)).rejects.toThrow();
    expect(
      await revokeAutoGeoSourceMigrationApproval(
        first.approvalId,
        "evidence/approval-replaced",
      ),
    ).toBe(true);
    const replacement = await createAutoGeoSourceMigrationApproval(input);
    expect(replacement.approvalId).not.toBe(first.approvalId);
  });

  it("expires an old approval before recording a renewed approval", async () => {
    await testDb.seedProject();
    const approvedAt = new Date("2026-01-01T00:00:00.000Z");
    const input: AutoGeoSourceMigrationApprovalEvidence = approvalInput({
      clientRef: `synthetic-client-${crypto.randomUUID()}`,
      expiresAt: new Date(approvedAt.getTime() + 60 * 60 * 1_000).toISOString(),
    });
    const original = await createAutoGeoSourceMigrationApproval(
      input,
      approvedAt,
    );
    const renewedAt = new Date(approvedAt.getTime() + 2 * 60 * 60 * 1_000);
    const renewed = await createAutoGeoSourceMigrationApproval(
      {
        ...input,
        expiresAt: new Date(
          renewedAt.getTime() + 60 * 60 * 1_000,
        ).toISOString(),
      },
      renewedAt,
    );

    expect(renewed.approvalId).not.toBe(original.approvalId);
    const [expiredRow] = await db
      .select()
      .from(autoGeoSourceMigrationApprovals)
      .where(eq(autoGeoSourceMigrationApprovals.id, original.approvalId));
    expect(expiredRow).toMatchObject({
      status: "expired",
      revokedAt: renewedAt.toISOString(),
    });
    const [renewedRow] = await db
      .select()
      .from(autoGeoSourceMigrationApprovals)
      .where(eq(autoGeoSourceMigrationApprovals.id, renewed.approvalId));
    expect(renewedRow).toMatchObject({
      status: "approved",
      approvedAt: renewedAt.toISOString(),
      expiresAt: new Date(renewedAt.getTime() + 60 * 60 * 1_000).toISOString(),
    });
  });
});
