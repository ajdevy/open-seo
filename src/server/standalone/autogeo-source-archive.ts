import { z } from "zod";
import {
  AUTOGEO_SOURCE_CONTRACT_REVISION,
  classifyAutoGeoSourcePaths,
} from "./autogeo-source-contract";

export const AUTOGEO_SOURCE_ARCHIVE_ALGORITHM = "AES-GCM-256";
export const AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION = 1;

const clientRefSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);

export type EncryptedAutoGeoSourceArchive = {
  algorithm: typeof AUTOGEO_SOURCE_ARCHIVE_ALGORITHM;
  schemaVersion: typeof AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION;
  clientRef: string;
  sourceContractRevision: string;
  idempotencyKey: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
};

export interface AutoGeoSourceArchivePort {
  /**
   * Must be scoped to the supplied clientRef and create-only by idempotencyKey.
   * Replaying the exact envelope returns the same archive object; a different
   * envelope for that key must fail without replacing the saved object.
   */
  putEncryptedSourceArchive(
    envelope: EncryptedAutoGeoSourceArchive,
  ): Promise<{ fileId: string }>;
  readEncryptedSourceArchive(
    clientRef: string,
    idempotencyKey: string,
  ): Promise<{
    fileId: string;
    envelope: EncryptedAutoGeoSourceArchive;
  } | null>;
}

export type AutoGeoSourceArchiveDelivery =
  | { status: "confirmed"; fileId: string; artifactCount: number }
  | {
      status: "unconfirmed";
      reason:
        | "invalid_envelope"
        | "write_unconfirmed"
        | "readback_unavailable"
        | "readback_missing"
        | "readback_mismatch"
        | "decrypt_failed"
        | "archive_payload_invalid";
      fileId?: string;
    };

const preparedInputSchema = z
  .object({
    clientRef: clientRefSchema,
    sourceContractRevision: z.literal(AUTOGEO_SOURCE_CONTRACT_REVISION),
    idempotencyKey: idempotencyKeySchema,
    artifacts: z
      .record(z.string(), z.instanceof(Uint8Array))
      .refine(
        (artifacts) => Object.keys(artifacts).length > 0,
        "At least one source artifact is required.",
      ),
  })
  .strict();

const envelopeSchema = z
  .object({
    algorithm: z.literal(AUTOGEO_SOURCE_ARCHIVE_ALGORITHM),
    schemaVersion: z.literal(AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION),
    clientRef: clientRefSchema,
    sourceContractRevision: z.literal(AUTOGEO_SOURCE_CONTRACT_REVISION),
    idempotencyKey: idempotencyKeySchema,
    iv: z.instanceof(Uint8Array).refine((value) => value.byteLength === 12),
    ciphertext: z
      .instanceof(Uint8Array)
      .refine((value) => value.byteLength >= 16),
  })
  .strict();

const archiveFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    base64: z.string(),
  })
  .strict();

const archivePayloadSchema = z
  .object({
    format: z.literal("autogeo-source-artifacts"),
    schemaVersion: z.literal(AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION),
    files: z.array(archiveFileSchema).min(1),
  })
  .strict();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function archiveAdditionalData(envelope: {
  clientRef: string;
  sourceContractRevision: string;
  idempotencyKey: string;
}): ArrayBuffer {
  return toArrayBuffer(
    new TextEncoder().encode(
      `open-seo:autogeo-source-archive:v${AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION}:${envelope.clientRef}:${envelope.sourceContractRevision}:${envelope.idempotencyKey}`,
    ),
  );
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("invalid base64");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintAutoGeoSourceArtifacts(
  artifacts: Record<string, Uint8Array>,
): Promise<string> {
  const paths = Object.keys(artifacts);
  if (paths.length === 0) throw new Error("source artifacts are empty");
  classifyAutoGeoSourcePaths(paths);
  const entries = await Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: await sha256(artifacts[path]),
    })),
  );
  // oxlint-disable-next-line unicorn/no-array-sort
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return sha256(new TextEncoder().encode(JSON.stringify(entries)));
}

function validArchiveKey(key: CryptoKey): boolean {
  return (
    key.algorithm.name === "AES-GCM" &&
    "length" in key.algorithm &&
    key.algorithm.length === 256 &&
    !key.extractable &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

export async function prepareEncryptedAutoGeoSourceArchive(
  rawInput: {
    clientRef: string;
    sourceContractRevision: string;
    idempotencyKey: string;
    artifacts: Record<string, Uint8Array>;
  },
  key: CryptoKey,
): Promise<EncryptedAutoGeoSourceArchive> {
  const input = preparedInputSchema.parse(rawInput);
  const paths = Object.keys(input.artifacts);
  classifyAutoGeoSourcePaths(paths);
  if (!validArchiveKey(key)) throw new Error("invalid source archive key");

  const files = await Promise.all(
    paths.map(async (path) => {
      const bytes = input.artifacts[path];
      return {
        path,
        sha256: await sha256(bytes),
        base64: encodeBase64(bytes),
      };
    }),
  );
  const payload = new TextEncoder().encode(
    JSON.stringify({
      format: "autogeo-source-artifacts",
      schemaVersion: AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION,
      files,
    }),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelopeHeader = {
    clientRef: input.clientRef,
    sourceContractRevision: input.sourceContractRevision,
    idempotencyKey: input.idempotencyKey,
  };
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: archiveAdditionalData(envelopeHeader),
      tagLength: 128,
    },
    key,
    toArrayBuffer(payload),
  );

  return {
    algorithm: AUTOGEO_SOURCE_ARCHIVE_ALGORITHM,
    schemaVersion: AUTOGEO_SOURCE_ARCHIVE_SCHEMA_VERSION,
    ...envelopeHeader,
    iv,
    ciphertext: new Uint8Array(encrypted),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

async function verifyPayload(
  ciphertext: Uint8Array,
  envelope: EncryptedAutoGeoSourceArchive,
  key: CryptoKey,
): Promise<number | null> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(envelope.iv),
        additionalData: archiveAdditionalData(envelope),
        tagLength: 128,
      },
      key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    return null;
  }

  try {
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    const parsed = archivePayloadSchema.safeParse(raw);
    if (!parsed.success) return null;
    const files = parsed.data.files;
    const paths = files.map((file) => file.path);
    classifyAutoGeoSourcePaths(paths);
    if (new Set(paths).size !== paths.length) return null;
    for (const file of files) {
      const bytes = decodeBase64(file.base64);
      if ((await sha256(bytes)) !== file.sha256) return null;
    }
    return files.length;
  } catch {
    return null;
  }
}

export async function deliverEncryptedAutoGeoSourceArchive(
  rawEnvelope: EncryptedAutoGeoSourceArchive,
  key: CryptoKey,
  port: AutoGeoSourceArchivePort,
): Promise<AutoGeoSourceArchiveDelivery> {
  const parsed = envelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success || !validArchiveKey(key))
    return { status: "unconfirmed", reason: "invalid_envelope" };
  const envelope = parsed.data;
  let receipt: { fileId: string };
  try {
    receipt = await port.putEncryptedSourceArchive(envelope);
  } catch {
    return { status: "unconfirmed", reason: "write_unconfirmed" };
  }

  let saved: Awaited<
    ReturnType<AutoGeoSourceArchivePort["readEncryptedSourceArchive"]>
  >;
  try {
    saved = await port.readEncryptedSourceArchive(
      envelope.clientRef,
      envelope.idempotencyKey,
    );
  } catch {
    return {
      status: "unconfirmed",
      reason: "readback_unavailable",
      fileId: receipt.fileId,
    };
  }
  if (!saved)
    return {
      status: "unconfirmed",
      reason: "readback_missing",
      fileId: receipt.fileId,
    };
  const savedEnvelope = envelopeSchema.safeParse(saved.envelope);
  if (
    saved.fileId !== receipt.fileId ||
    !savedEnvelope.success ||
    savedEnvelope.data.algorithm !== envelope.algorithm ||
    savedEnvelope.data.schemaVersion !== envelope.schemaVersion ||
    savedEnvelope.data.clientRef !== envelope.clientRef ||
    savedEnvelope.data.sourceContractRevision !==
      envelope.sourceContractRevision ||
    savedEnvelope.data.idempotencyKey !== envelope.idempotencyKey ||
    !sameBytes(savedEnvelope.data.iv, envelope.iv) ||
    !sameBytes(savedEnvelope.data.ciphertext, envelope.ciphertext)
  )
    return {
      status: "unconfirmed",
      reason: "readback_mismatch",
      fileId: receipt.fileId,
    };

  const artifactCount = await verifyPayload(
    savedEnvelope.data.ciphertext,
    savedEnvelope.data,
    key,
  );
  if (artifactCount === null)
    return {
      status: "unconfirmed",
      reason: "archive_payload_invalid",
      fileId: receipt.fileId,
    };
  return { status: "confirmed", fileId: receipt.fileId, artifactCount };
}
