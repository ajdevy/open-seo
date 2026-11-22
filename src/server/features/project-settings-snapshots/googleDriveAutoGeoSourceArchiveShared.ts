import { z } from "zod";
import {
  parseEncryptedAutoGeoSourceArchive,
  type AutoGeoSourceArchivePort,
  type AutoGeoSourceArchiveTargetBinding,
} from "@/server/standalone/autogeo-source-archive";

export const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
export const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3";
export const GOOGLE_DRIVE_FOLDER_MIME_TYPE =
  "application/vnd.google-apps.folder";
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_SOURCE_ARCHIVE_READBACK_BYTES = 12 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type DriveAccess = {
  target: AutoGeoSourceArchiveTargetBinding;
  folderId: string;
  accessToken: string;
};

export type DriveFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export const driveFileSchema = z.object({
  id: z.string().min(1),
  appProperties: z.record(z.string(), z.string()).optional(),
  parents: z.array(z.string()).optional(),
  trashed: z.boolean(),
});

export type DriveFile = z.infer<typeof driveFileSchema>;

export const driveFolderSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string(),
  trashed: z.boolean(),
  capabilities: z.object({ canAddChildren: z.boolean().optional() }).optional(),
});

export const driveListSchema = z.object({
  files: z.array(driveFileSchema).optional().default([]),
  incompleteSearch: z.boolean().optional().default(false),
  nextPageToken: z.string().optional(),
});

export const generatedIdsSchema = z.object({
  ids: z.array(z.string().min(1)).length(1),
});

export function validateDriveId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{5,200}$/u.test(id))
    throw new Error("Google Drive source archive ID is invalid.");
  return id;
}

export function sameTarget(
  left: AutoGeoSourceArchiveTargetBinding,
  right: AutoGeoSourceArchiveTargetBinding,
) {
  return (
    left.connectionId === right.connectionId &&
    left.organizationId === right.organizationId &&
    left.googleAccountId === right.googleAccountId &&
    left.folderId === right.folderId
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
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    throw new Error("Google Drive source archive envelope is invalid.");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function serializeEnvelope(
  envelope: Parameters<
    AutoGeoSourceArchivePort["putEncryptedSourceArchive"]
  >[0],
) {
  return JSON.stringify({
    algorithm: envelope.algorithm,
    schemaVersion: envelope.schemaVersion,
    clientRef: envelope.clientRef,
    sourceContractRevision: envelope.sourceContractRevision,
    idempotencyKey: envelope.idempotencyKey,
    iv: encodeBase64(envelope.iv),
    ciphertext: encodeBase64(envelope.ciphertext),
  });
}

export function parseEnvelope(value: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("Google Drive source archive envelope is invalid.");
  }
  if (!isRecord(raw))
    throw new Error("Google Drive source archive envelope is invalid.");
  const envelope = raw;
  if (
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  )
    throw new Error("Google Drive source archive envelope is invalid.");
  return parseEncryptedAutoGeoSourceArchive({
    ...envelope,
    iv: decodeBase64(envelope.iv),
    ciphertext: decodeBase64(envelope.ciphertext),
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseResponse<T>(
  value: unknown,
  schema: z.ZodType<T>,
  label: string,
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Google Drive source archive ${label} is invalid.`);
  return parsed.data;
}

export function statusError(action: string, status: number) {
  return new Error(
    `Google Drive source archive ${action} failed (HTTP ${status}).`,
  );
}

export async function readLimitedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maximumBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(
        "Google Drive source archive response exceeds its limit.",
      );
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(
          "Google Drive source archive response exceeds its limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function driveRequest(
  accessToken: string,
  fetcher: DriveFetch,
  url: URL,
  init: RequestInit = {},
  allowConflict = false,
) {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Google Drive source archive request failed.");
  }
  if (!response.ok && !(allowConflict && response.status === 409))
    throw statusError("request", response.status);
  return response;
}

export function createDriveArchiveHelpers(input: {
  resolveAccess: (organizationId: string) => Promise<DriveAccess>;
  fetcher: DriveFetch;
}) {
  const { resolveAccess, fetcher } = input;

  async function accessFor(
    organizationId: string,
    expectedTarget?: AutoGeoSourceArchiveTargetBinding,
  ): Promise<DriveAccess> {
    const access = await resolveAccess(organizationId);
    validateDriveId(access.folderId);
    if (
      !access.accessToken.trim() ||
      access.target.organizationId !== organizationId ||
      access.target.folderId !== access.folderId ||
      (expectedTarget && !sameTarget(access.target, expectedTarget))
    )
      throw new Error("Google Drive source archive target changed.");
    return access;
  }

  async function ensureWritableFolder(access: DriveAccess): Promise<string> {
    const folderId = validateDriveId(access.folderId);
    const url = new URL(
      `${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(folderId)}`,
    );
    url.searchParams.set(
      "fields",
      "id,mimeType,trashed,capabilities(canAddChildren)",
    );
    url.searchParams.set("supportsAllDrives", "true");
    let payload: unknown;
    try {
      payload = await (
        await driveRequest(access.accessToken, fetcher, url)
      ).json();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Google Drive"))
        throw error;
      throw new Error(
        "Google Drive source archive folder response is invalid.",
        {
          cause: error,
        },
      );
    }
    const folder = parseResponse(payload, driveFolderSchema, "folder response");
    if (
      folder.id !== folderId ||
      folder.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE ||
      folder.trashed ||
      folder.capabilities?.canAddChildren !== true
    )
      throw new Error("Google Drive source archive folder is not writable.");
    return folderId;
  }

  async function getFileById(access: DriveAccess, fileId: string) {
    const url = new URL(
      `${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(validateDriveId(fileId))}`,
    );
    url.searchParams.set("fields", "id,appProperties,parents,trashed");
    url.searchParams.set("supportsAllDrives", "true");
    try {
      return parseResponse(
        await (await driveRequest(access.accessToken, fetcher, url)).json(),
        driveFileSchema,
        "file response",
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404"))
        return null;
      throw error;
    }
  }

  async function findExisting(
    access: DriveAccess,
    folderId: string,
    idempotencyHash: string,
    clientRefHash: string,
  ) {
    const url = new URL(`${GOOGLE_DRIVE_API_URL}/files`);
    url.searchParams.set(
      "q",
      `'${folderId}' in parents and trashed = false and appProperties has { key='openSeoSourceIdempotencyHash' and value='${idempotencyHash}' } and appProperties has { key='openSeoSourceClientRefHash' and value='${clientRefHash}' }`,
    );
    url.searchParams.set("pageSize", "2");
    url.searchParams.set(
      "fields",
      "files(id,appProperties,parents,trashed),incompleteSearch,nextPageToken",
    );
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    const result = parseResponse(
      await (await driveRequest(access.accessToken, fetcher, url)).json(),
      driveListSchema,
      "lookup response",
    );
    if (result.incompleteSearch || result.nextPageToken)
      throw new Error("Google Drive source archive lookup was incomplete.");
    if (result.files.length > 1)
      throw new Error("Google Drive source archive has duplicate records.");
    return result.files[0] ?? null;
  }

  async function verifyStoredFile(details: {
    access: DriveAccess;
    folderId: string;
    file: DriveFile;
    fileId: string;
    idempotencyHash: string;
    clientRefHash: string;
    payloadHash: string;
    sourceContractRevision: string;
  }) {
    const {
      access,
      folderId,
      file,
      fileId,
      idempotencyHash,
      clientRefHash,
      payloadHash,
      sourceContractRevision,
    } = details;
    const properties = file.appProperties ?? {};
    if (
      file.id !== fileId ||
      file.trashed ||
      !file.parents?.includes(folderId) ||
      properties.openSeoSourceKind !== "autogeo-source-migration" ||
      properties.openSeoSourceIdempotencyHash !== idempotencyHash ||
      properties.openSeoSourceClientRefHash !== clientRefHash ||
      properties.openSeoSourcePayloadSha256 !== payloadHash ||
      properties.openSeoSourceRevision !== sourceContractRevision
    )
      throw new Error("Google Drive source archive binding is invalid.");
    const url = new URL(
      `${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(file.id)}`,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await driveRequest(access.accessToken, fetcher, url);
    const bytes = await readLimitedResponseBody(
      response,
      MAX_SOURCE_ARCHIVE_READBACK_BYTES,
    );
    if ((await sha256Hex(bytes)) !== payloadHash)
      throw new Error(
        "Google Drive source archive read-back hash did not match.",
      );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async function verifiedExisting(
    access: DriveAccess,
    folderId: string,
    file: DriveFile,
    expected: {
      fileId: string;
      idempotencyHash: string;
      clientRefHash: string;
      payloadHash: string;
      sourceContractRevision: string;
    },
  ) {
    return verifyStoredFile({ access, folderId, file, ...expected });
  }

  return {
    accessFor,
    ensureWritableFolder,
    findExisting,
    getFileById,
    verifiedExisting,
  };
}
