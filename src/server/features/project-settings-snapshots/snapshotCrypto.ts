import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";

export const PROJECT_SETTINGS_SNAPSHOT_VERSION = 1;
export const PROJECT_SETTINGS_SNAPSHOT_ALGORITHM = "AES-GCM-256";

export interface EncryptedSnapshot {
  algorithm: string;
  schemaVersion: number;
  iv: string;
  ciphertext: string;
}

function decodeMasterKey(value: string): Uint8Array {
  const encoded = value.trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new AppError(
      "INTERNAL_ERROR",
      "Snapshot encryption is not configured.",
    );

  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new AppError(
      "INTERNAL_ERROR",
      "Snapshot encryption is not configured.",
    );
  }
  if (binary.length !== 32)
    throw new AppError(
      "INTERNAL_ERROR",
      "Snapshot encryption is not configured.",
    );

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importMasterKey(): Promise<CryptoKey> {
  const value = await getOptionalEnvValue("AUTOGEO_QUEUE_MASTER_KEY_B64");
  if (!value)
    throw new AppError(
      "INTERNAL_ERROR",
      "Snapshot encryption is not configured.",
    );

  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(decodeMasterKey(value)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

function additionalData(projectId: string, revision: number): ArrayBuffer {
  return toArrayBuffer(
    new TextEncoder().encode(
      `open-seo:project-settings-snapshot:v${PROJECT_SETTINGS_SNAPSHOT_VERSION}:${projectId}:${revision}`,
    ),
  );
}

export async function encryptProjectSettingsSnapshot(
  payload: unknown,
  projectId: string,
  revision: number,
): Promise<EncryptedSnapshot> {
  const key = await importMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: additionalData(projectId, revision),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  return {
    algorithm: PROJECT_SETTINGS_SNAPSHOT_ALGORITHM,
    schemaVersion: PROJECT_SETTINGS_SNAPSHOT_VERSION,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptProjectSettingsSnapshot(input: {
  projectId: string;
  revision: number;
  algorithm: string;
  schemaVersion: number;
  iv: string;
  ciphertext: string;
}): Promise<unknown> {
  if (
    input.algorithm !== PROJECT_SETTINGS_SNAPSHOT_ALGORITHM ||
    input.schemaVersion !== PROJECT_SETTINGS_SNAPSHOT_VERSION
  )
    throw new AppError("INTERNAL_ERROR", "Snapshot format is unsupported.");

  const key = await importMasterKey();
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(decodeBase64(input.iv)),
      additionalData: additionalData(input.projectId, input.revision),
      tagLength: 128,
    },
    key,
    toArrayBuffer(decodeBase64(input.ciphertext)),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
