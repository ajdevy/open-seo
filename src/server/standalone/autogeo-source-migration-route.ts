import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { createGoogleDriveAutoGeoSourceArchivePort } from "@/server/features/project-settings-snapshots/googleDriveAutoGeoSourceArchive";
import { autoGeoSourceMigrationOutbox } from "./autogeo-source-migration-outbox";
import {
  runAutoGeoSourceMigration,
  type AutoGeoMigrationApproval,
} from "./autogeo-source-migration";
import { AUTOGEO_SOURCE_ARCHIVE_MAX_ARTIFACT_BYTES } from "./autogeo-source-archive";
import {
  autoGeoSourceMigrationAuthorization,
  createAutoGeoSourceMigrationApproval,
  revokeAutoGeoSourceMigrationApproval,
} from "./autogeo-source-migration-approval";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "./autogeo-source-contract";
import { mappingApprovalSchema } from "./autogeo-source-adapter-schema";
import { isOperatorRequest } from "./operator-auth";

// This route materializes the parsed artifact set, archive plan, encrypted
// envelope, and Drive multipart payload. Keep the request bounded until those
// stages have a fully streaming implementation.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const idSchema = z.string().trim().min(1).max(200);
const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,239}$/u);
const digestRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const clientRefSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);

const commandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("approve"),
      clientRef: clientRefSchema,
      targetOrganizationId: idSchema,
      sourceContractRevision: z.literal(AUTOGEO_SOURCE_CONTRACT_REVISION),
      mapping: mappingApprovalSchema,
      sourceArtifactsFingerprint: digestRefSchema,
      sourceReadEvidenceRef: digestRefSchema,
      targetWriteEvidenceRef: digestRefSchema,
      archiveDestinationEvidenceRef: digestRefSchema,
      retentionEvidenceRef: digestRefSchema,
      restoreEvidenceRef: digestRefSchema,
      expiresAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      command: z.literal("revoke"),
      approvalId: z.string().uuid(),
      evidenceRef: refSchema,
    })
    .strict(),
  z
    .object({
      command: z.literal("run"),
      targetOrganizationId: idSchema,
      idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u),
      mapping: z.unknown(),
      artifacts: z
        .array(
          z
            .object({
              path: z.string().min(1).max(512),
              base64: z.string().max(MAX_REQUEST_BYTES),
            })
            .strict(),
        )
        .min(1)
        .max(2_000),
    })
    .strict(),
]);

function decodeBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    throw new Error("Source artifact encoding is invalid.");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function sourceArchiveKey(): Promise<CryptoKey> {
  const encoded = await getOptionalEnvValue("AUTOGEO_QUEUE_MASTER_KEY_B64");
  if (!encoded)
    throw new Error("AutoGeo source archive encryption is not configured.");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded.trim(),
    )
  )
    throw new Error("AutoGeo source archive encryption is not configured.");
  let binary: string;
  try {
    binary = atob(encoded.trim());
  } catch {
    throw new Error("AutoGeo source archive encryption is not configured.");
  }
  if (binary.length !== 32)
    throw new Error("AutoGeo source archive encryption is not configured.");
  const master = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    ),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("open-seo-autogeo-source-archive-v1"),
      info: new TextEncoder().encode("AES-GCM-256 source archive key"),
    },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function parseRequestBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength =
    contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (
    contentLengthHeader !== null &&
    (!/^\d+$/u.test(contentLengthHeader) ||
      !Number.isSafeInteger(contentLength))
  )
    return {
      ok: false,
      response: Response.json(
        { error: "Invalid AutoGeo migration request" },
        { status: 400 },
      ),
    };
  if (contentLength !== null && contentLength > MAX_REQUEST_BYTES)
    return {
      ok: false,
      response: Response.json(
        { error: "AutoGeo migration request exceeds the 8 MiB limit" },
        { status: 413 },
      ),
    };

  const reader = request.body?.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const bodyParts: string[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_REQUEST_BYTES) {
          void reader.cancel().catch(() => undefined);
          return {
            ok: false,
            response: Response.json(
              { error: "AutoGeo migration request exceeds the 8 MiB limit" },
              { status: 413 },
            ),
          };
        }
        if (contentLength !== null && totalBytes > contentLength) {
          void reader.cancel().catch(() => undefined);
          return {
            ok: false,
            response: Response.json(
              { error: "Invalid AutoGeo migration request" },
              { status: 400 },
            ),
          };
        }
        const decoded = decoder.decode(value, { stream: true });
        if (decoded) bodyParts.push(decoded);
        // Coalesce small transport chunks so a bounded body cannot become an
        // unbounded array of tiny strings.
        if (bodyParts.length >= 64) {
          const coalesced = bodyParts.join("");
          bodyParts.length = 0;
          bodyParts.push(coalesced);
        }
      }
      const finalDecoded = decoder.decode();
      if (finalDecoded) bodyParts.push(finalDecoded);
    } catch {
      return {
        ok: false,
        response: Response.json(
          { error: "Invalid AutoGeo migration request" },
          { status: 400 },
        ),
      };
    } finally {
      reader.releaseLock();
    }
  }
  if (contentLength !== null && totalBytes !== contentLength)
    return {
      ok: false,
      response: Response.json(
        { error: "Invalid AutoGeo migration request" },
        { status: 400 },
      ),
    };

  const body = bodyParts.join("");
  try {
    const value: unknown = JSON.parse(body);
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: "Invalid AutoGeo migration request" },
        { status: 400 },
      ),
    };
  }
}

function decodeArtifacts(
  entries: Array<{ path: string; base64: string }>,
): Record<string, Uint8Array> {
  const artifacts: Record<string, Uint8Array> = {};
  let totalBytes = 0;
  for (const entry of entries) {
    if (Object.hasOwn(artifacts, entry.path))
      throw new Error("Source artifact paths must be unique.");
    const padding = entry.base64.endsWith("==")
      ? 2
      : entry.base64.endsWith("=")
        ? 1
        : 0;
    totalBytes += Math.floor((entry.base64.length * 3) / 4) - padding;
    if (totalBytes > AUTOGEO_SOURCE_ARCHIVE_MAX_ARTIFACT_BYTES)
      throw new Error("AutoGeo source archive exceeds the 4 MiB limit.");
    Object.defineProperty(artifacts, entry.path, {
      value: decodeBase64(entry.base64),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return artifacts;
}

export async function handleAutoGeoSourceMigrationRequest(
  request: Request,
): Promise<Response> {
  if (request.method !== "POST" || !isOperatorRequest(request.headers))
    return new Response("Not found", { status: 404 });
  const parsedBody = await parseRequestBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = commandSchema.safeParse(parsedBody.value);
  if (!parsed.success)
    return Response.json(
      { error: "Invalid AutoGeo migration request" },
      { status: 400 },
    );

  try {
    if (parsed.data.command === "approve") {
      const result = await createAutoGeoSourceMigrationApproval({
        clientRef: parsed.data.clientRef,
        targetOrganizationId: parsed.data.targetOrganizationId,
        sourceContractRevision: parsed.data.sourceContractRevision,
        mapping: parsed.data.mapping,
        sourceArtifactsFingerprint: parsed.data.sourceArtifactsFingerprint,
        sourceReadEvidenceRef: parsed.data.sourceReadEvidenceRef,
        targetWriteEvidenceRef: parsed.data.targetWriteEvidenceRef,
        archiveDestinationEvidenceRef:
          parsed.data.archiveDestinationEvidenceRef,
        retentionEvidenceRef: parsed.data.retentionEvidenceRef,
        restoreEvidenceRef: parsed.data.restoreEvidenceRef,
        expiresAt: parsed.data.expiresAt,
      });
      return Response.json({ ...result, status: "approved" }, { status: 201 });
    }
    if (parsed.data.command === "revoke") {
      const revoked = await revokeAutoGeoSourceMigrationApproval(
        parsed.data.approvalId,
        parsed.data.evidenceRef,
      );
      return revoked
        ? Response.json({ status: "revoked" })
        : Response.json(
            { error: "Active approval not found" },
            { status: 404 },
          );
    }

    const runRequest = parsed.data;
    const archiveKey = await sourceArchiveKey();
    const artifacts = runRequest.artifacts;
    const result = await runAutoGeoSourceMigration({
      targetOrganizationId: runRequest.targetOrganizationId,
      idempotencyKey: runRequest.idempotencyKey,
      mapping: runRequest.mapping,
      authorization: autoGeoSourceMigrationAuthorization,
      outbox: autoGeoSourceMigrationOutbox,
      archiveKey,
      archivePort: createGoogleDriveAutoGeoSourceArchivePort(),
      async readSourceArtifacts(approval: AutoGeoMigrationApproval) {
        if (approval.targetOrganizationId !== runRequest.targetOrganizationId)
          throw new Error("Approval binding changed.");
        return decodeArtifacts(artifacts);
      },
    });
    const status = result.status === "blocked" ? 409 : 200;
    return Response.json(result, { status });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "An active approval already exists."
    )
      return Response.json({ error: error.message }, { status: 409 });
    if (
      error instanceof Error &&
      error.message === "Target organization does not exist."
    )
      return Response.json({ error: error.message }, { status: 404 });
    if (
      error instanceof Error &&
      error.message === "AutoGeo source archive encryption is not configured."
    )
      return Response.json({ error: error.message }, { status: 503 });
    if (
      error instanceof Error &&
      (error.message.includes("Approval") ||
        error.message.includes("approval") ||
        error.message.includes("Source artifact") ||
        error.message.includes("source archive"))
    )
      return Response.json({ error: error.message }, { status: 400 });
    return Response.json(
      { error: "AutoGeo source migration could not be completed" },
      { status: 500 },
    );
  }
}
