import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isOperatorRequest: vi.fn(() => true),
  getOptionalEnvValue: vi.fn(
    async () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ),
  createGoogleDriveAutoGeoSourceArchivePort: vi.fn(() => ({
    generateFileId: vi.fn(),
    putEncryptedSourceArchive: vi.fn(),
    readEncryptedSourceArchive: vi.fn(),
  })),
  createApproval: vi.fn(),
  revokeApproval: vi.fn(),
  authorize: vi.fn(),
  putIfAbsent: vi.fn(),
  reserveArchiveFileId: vi.fn(),
  markArchived: vi.fn(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: mocks.getOptionalEnvValue,
}));
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
  waitUntil: vi.fn(),
}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/runBatch", () => ({ runBatch: vi.fn() }));
vi.mock(
  "@/server/features/project-settings-snapshots/googleDriveAutoGeoSourceArchive",
  () => ({
    createGoogleDriveAutoGeoSourceArchivePort:
      mocks.createGoogleDriveAutoGeoSourceArchivePort,
  }),
);
vi.mock("./autogeo-source-migration-outbox", () => ({
  autoGeoSourceMigrationOutbox: {
    putIfAbsent: mocks.putIfAbsent,
    reserveArchiveFileId: mocks.reserveArchiveFileId,
    markArchived: mocks.markArchived,
  },
}));
vi.mock("./autogeo-source-migration-approval", () => ({
  autoGeoSourceMigrationAuthorization: { authorize: mocks.authorize },
  createAutoGeoSourceMigrationApproval: mocks.createApproval,
  revokeAutoGeoSourceMigrationApproval: mocks.revokeApproval,
}));
vi.mock("./operator-auth", () => ({
  isOperatorRequest: mocks.isOperatorRequest,
}));

import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";
import { reviewedMapping } from "./autogeo-source-migration.test-fixtures";
import { handleAutoGeoSourceMigrationRequest } from "./autogeo-source-migration-route";

function request(body: string, headers: HeadersInit = {}) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  return new Request(
    "https://open-seo.example/api/standalone/autogeo-source-migration",
    {
      method: "POST",
      headers: requestHeaders,
      body,
    },
  );
}

function streamingRequest(body: ReadableStream<Uint8Array>) {
  return new Request(
    "https://open-seo.example/api/standalone/autogeo-source-migration",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit,
  );
}

function approvalPayload(
  overrides: { clientRef?: string; targetOrganizationId?: string } = {},
) {
  const { mappingEvidenceRef: _mappingEvidenceRef, ...originalMapping } =
    reviewedMapping();
  const mapping = {
    ...originalMapping,
    ...(typeof overrides.clientRef === "string"
      ? { clientRef: overrides.clientRef }
      : {}),
  };
  return {
    command: "approve",
    clientRef: mapping.clientRef,
    targetOrganizationId: "target-1",
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

beforeEach(() => {
  mocks.isOperatorRequest.mockReturnValue(true);
  mocks.getOptionalEnvValue.mockResolvedValue(
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  );
  mocks.createApproval.mockResolvedValue({
    approvalId: "00000000-0000-4000-8000-000000000001",
    approvedAt: "2026-11-22T00:00:00.000Z",
    mappingEvidenceRef: `autogeo-evidence-v1:${"a".repeat(64)}:${"b".repeat(64)}:${"c".repeat(64)}`,
  });
  mocks.revokeApproval.mockResolvedValue(true);
  mocks.authorize.mockResolvedValue(null);
});

describe("standalone AutoGeo migration route", () => {
  it("authenticates before reading request content", async () => {
    mocks.isOperatorRequest.mockReturnValue(false);
    const response = await handleAutoGeoSourceMigrationRequest(
      request("{invalid"),
    );

    expect(response.status).toBe(404);
    expect(mocks.createApproval).not.toHaveBeenCalled();
  });

  it("records an explicit, mapping-bound operator approval", async () => {
    const body = approvalPayload({ clientRef: "synthetic-client" });
    const response = await handleAutoGeoSourceMigrationRequest(
      request(JSON.stringify(body)),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "approved" });
    expect(mocks.createApproval).toHaveBeenCalledWith({
      clientRef: body.clientRef,
      targetOrganizationId: body.targetOrganizationId,
      sourceContractRevision: body.sourceContractRevision,
      mapping: body.mapping,
      sourceArtifactsFingerprint: body.sourceArtifactsFingerprint,
      sourceReadEvidenceRef: body.sourceReadEvidenceRef,
      targetWriteEvidenceRef: body.targetWriteEvidenceRef,
      archiveDestinationEvidenceRef: body.archiveDestinationEvidenceRef,
      retentionEvidenceRef: body.retentionEvidenceRef,
      restoreEvidenceRef: body.restoreEvidenceRef,
      expiresAt: body.expiresAt,
    });
  });

  it("returns a conflict when a matching approval is already active", async () => {
    mocks.createApproval.mockRejectedValue(
      new Error("An active approval already exists."),
    );
    const response = await handleAutoGeoSourceMigrationRequest(
      request(
        JSON.stringify(approvalPayload({ clientRef: "synthetic-client" })),
      ),
    );

    expect(response.status).toBe(409);
  });

  it("decodes streamed UTF-8 across tiny chunks and coalesces their text", async () => {
    const body = approvalPayload({ targetOrganizationId: "организация-1" });
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += 1)
          controller.enqueue(bytes.subarray(offset, offset + 1));
        controller.close();
      },
    });

    const response = await handleAutoGeoSourceMigrationRequest(
      streamingRequest(stream),
    );

    expect(response.status).toBe(201);
    expect(mocks.createApproval).toHaveBeenCalledWith(
      expect.objectContaining({ targetOrganizationId: "организация-1" }),
    );
  });

  it("rejects a streamed body that exceeds its declared content length", async () => {
    const response = await handleAutoGeoSourceMigrationRequest(
      request("{}", { "content-length": "1" }),
    );

    expect(response.status).toBe(400);
  });

  it("does not decode or persist source bytes unless the exact approval exists", async () => {
    const response = await handleAutoGeoSourceMigrationRequest(
      request(
        JSON.stringify({
          command: "run",
          targetOrganizationId: "target-1",
          idempotencyKey: "synthetic-unapproved-run",
          mapping: reviewedMapping(),
          artifacts: [{ path: "prompts/matrix-v1.jsonl", base64: "%%%" }],
        }),
      ),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      status: "blocked",
      reason: "authorization_required",
    });
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    expect(mocks.authorize.mock.calls[0]?.[0]).toMatchObject({
      clientRef: "synthetic-auto-client",
      targetOrganizationId: "target-1",
      mapping: { mappingEvidenceRef: "review/4-3/synthetic-map-2" },
    });
    expect(mocks.putIfAbsent).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies before parsing", async () => {
    const response = await handleAutoGeoSourceMigrationRequest(
      request("{}", { "content-length": String(9 * 1024 * 1024) }),
    );

    expect(response.status).toBe(413);
  });

  it("cancels a chunked request as soon as its streamed body exceeds the cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let emittedChunks = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emittedChunks += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });

    const response = await handleAutoGeoSourceMigrationRequest(
      streamingRequest(body),
    );

    expect(response.status).toBe(413);
    expect(emittedChunks).toBeLessThan(80);
    await Promise.resolve();
    expect(canceled).toBe(true);
  });
});
