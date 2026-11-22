import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { DB_BATCH_SIZE } from "@/db/runBatch";
import { autoGeoSourceMigrationOutboxChunks } from "@/db/schema";
import { z } from "zod";
import {
  parseEncryptedAutoGeoSourceArchive,
  type EncryptedAutoGeoSourceArchive,
} from "./autogeo-source-archive";
import type { AutoGeoSourceMigrationOutboxRecord } from "./autogeo-source-migration";

const legacyPersistedEnvelopeSchema = z
  .object({
    algorithm: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    clientRef: z.string().min(1),
    sourceContractRevision: z.string().min(1),
    idempotencyKey: z.string().min(1),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

const chunkedEnvelopeMetadataSchema = z
  .object({
    storageVersion: z.literal(2),
    algorithm: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    clientRef: z.string().min(1),
    sourceContractRevision: z.string().min(1),
    idempotencyKey: z.string().min(1),
    iv: z.string().min(1),
    ciphertextByteLength: z.number().int().positive().max(100 * 1024 * 1024),
    ciphertextSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    chunkCount: z.number().int().positive().max(DB_BATCH_SIZE - 1),
  })
  .strict();

const OUTBOX_CHUNK_BYTES = 1024 * 1024;
// Keep each D1 read around 15 MiB to leave memory for the reconstructed archive.
const OUTBOX_CHUNKS_PER_READ = 8;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    throw new Error("Encrypted AutoGeo source outbox envelope is invalid.");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function envelopeDigest(bytes: Uint8Array): Promise<ArrayBuffer> {
  const backingBuffer = bytes.buffer;
  if (
    backingBuffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === backingBuffer.byteLength
  )
    return crypto.subtle.digest("SHA-256", backingBuffer);
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  return crypto.subtle.digest("SHA-256", stableBytes.buffer);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function serializeAutoGeoOutboxEnvelope(
  record: AutoGeoSourceMigrationOutboxRecord,
): Promise<{
  metadata: string;
  chunks: Array<{ chunkIndex: number; ciphertextBase64: string }>;
}> {
  const ciphertext = record.envelope.ciphertext;
  const chunks: Array<{ chunkIndex: number; ciphertextBase64: string }> = [];
  for (let offset = 0; offset < ciphertext.length; offset += OUTBOX_CHUNK_BYTES)
    chunks.push({
      chunkIndex: chunks.length,
      ciphertextBase64: encodeBase64(
        ciphertext.subarray(offset, offset + OUTBOX_CHUNK_BYTES),
      ),
    });
  if (chunks.length + 1 > DB_BATCH_SIZE)
    throw new Error("AutoGeo source archive exceeds the durable outbox limit.");
  return {
    metadata: JSON.stringify({
      storageVersion: 2,
      algorithm: record.envelope.algorithm,
      schemaVersion: record.envelope.schemaVersion,
      clientRef: record.envelope.clientRef,
      sourceContractRevision: record.envelope.sourceContractRevision,
      idempotencyKey: record.envelope.idempotencyKey,
      iv: encodeBase64(record.envelope.iv),
      ciphertextByteLength: ciphertext.byteLength,
      ciphertextSha256: toHex(await envelopeDigest(ciphertext)),
      chunkCount: chunks.length,
    }),
    chunks,
  };
}

async function chunkedCiphertext(
  storageId: string,
  metadata: z.infer<typeof chunkedEnvelopeMetadataSchema>,
): Promise<Uint8Array> {
  if (
    metadata.chunkCount !==
    Math.ceil(metadata.ciphertextByteLength / OUTBOX_CHUNK_BYTES)
  )
    throw new Error("Encrypted AutoGeo source outbox envelope is invalid.");
  const ciphertext = new Uint8Array(metadata.ciphertextByteLength);
  let destinationOffset = 0;
  for (
    let firstChunk = 0;
    firstChunk < metadata.chunkCount;
    firstChunk += OUTBOX_CHUNKS_PER_READ
  ) {
    const chunkEnd = Math.min(
      firstChunk + OUTBOX_CHUNKS_PER_READ,
      metadata.chunkCount,
    );
    const rows = await db
      .select({
        chunkIndex: autoGeoSourceMigrationOutboxChunks.chunkIndex,
        ciphertextBase64: autoGeoSourceMigrationOutboxChunks.ciphertextBase64,
      })
      .from(autoGeoSourceMigrationOutboxChunks)
      .where(
        and(
          eq(autoGeoSourceMigrationOutboxChunks.storageId, storageId),
          gte(autoGeoSourceMigrationOutboxChunks.chunkIndex, firstChunk),
          lt(autoGeoSourceMigrationOutboxChunks.chunkIndex, chunkEnd),
        ),
      )
      .orderBy(asc(autoGeoSourceMigrationOutboxChunks.chunkIndex));
    if (rows.length !== chunkEnd - firstChunk)
      throw new Error("Encrypted AutoGeo source outbox chunks are incomplete.");
    for (let offset = 0; offset < rows.length; offset += 1) {
      const row = rows[offset]!;
      const expectedIndex = firstChunk + offset;
      const bytes = decodeBase64(row.ciphertextBase64);
      const expectedLength = Math.min(
        OUTBOX_CHUNK_BYTES,
        metadata.ciphertextByteLength - destinationOffset,
      );
      if (row.chunkIndex !== expectedIndex || bytes.byteLength !== expectedLength)
        throw new Error("Encrypted AutoGeo source outbox chunks are invalid.");
      ciphertext.set(bytes, destinationOffset);
      destinationOffset += bytes.byteLength;
    }
  }
  if (
    destinationOffset !== metadata.ciphertextByteLength ||
    toHex(await envelopeDigest(ciphertext)) !== metadata.ciphertextSha256
  )
    throw new Error("Encrypted AutoGeo source outbox checksum mismatch.");
  return ciphertext;
}

export async function parseAutoGeoOutboxEnvelope(
  value: string,
  storageId: string | null,
): Promise<EncryptedAutoGeoSourceArchive> {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("Encrypted AutoGeo source outbox envelope is invalid.");
  }
  const legacy = legacyPersistedEnvelopeSchema.safeParse(raw);
  if (legacy.success) {
    if (storageId !== null)
      throw new Error("Encrypted AutoGeo source outbox envelope is invalid.");
    return parseEncryptedAutoGeoSourceArchive({
      ...legacy.data,
      iv: decodeBase64(legacy.data.iv),
      ciphertext: decodeBase64(legacy.data.ciphertext),
    });
  }
  const metadata = chunkedEnvelopeMetadataSchema.safeParse(raw);
  if (!metadata.success || !storageId)
    throw new Error("Encrypted AutoGeo source outbox envelope is invalid.");
  return parseEncryptedAutoGeoSourceArchive({
    algorithm: metadata.data.algorithm,
    schemaVersion: metadata.data.schemaVersion,
    clientRef: metadata.data.clientRef,
    sourceContractRevision: metadata.data.sourceContractRevision,
    idempotencyKey: metadata.data.idempotencyKey,
    iv: decodeBase64(metadata.data.iv),
    ciphertext: await chunkedCiphertext(storageId, metadata.data),
  });
}
