import { z } from "zod";
import type {
  EncryptedProjectSettingsSnapshot,
  ProjectSettingsSnapshotArchivePort,
} from "./snapshotDelivery";

const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const REQUEST_TIMEOUT_MS = 20_000;

const driveFileSchema = z.object({
  id: z.string().min(1),
  appProperties: z.record(z.string(), z.string()).optional(),
  parents: z.array(z.string()).optional(),
  trashed: z.boolean(),
});

const driveFolderSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string(),
  trashed: z.boolean(),
  capabilities: z.object({ canAddChildren: z.boolean().optional() }).optional(),
});

const driveListSchema = z.object({
  files: z.array(driveFileSchema).optional().default([]),
  incompleteSearch: z.boolean().optional().default(false),
  nextPageToken: z.string().optional(),
});

const driveGeneratedIdsSchema = z.object({
  ids: z.array(z.string().min(1)).length(1),
});

const driveCreateSchema = driveFileSchema;

type DriveAccess = {
  folderId: string;
  accessToken: string;
};

type DriveFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function validateFolderId(value: string): string {
  const folderId = value.trim();
  if (!/^[A-Za-z0-9_-]{5,200}$/u.test(folderId))
    throw new Error("Google Drive snapshot archive folder is invalid.");
  return folderId;
}

function validateGeneratedFileId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(value))
    throw new Error("Google Drive generated snapshot ID is invalid.");
  return value;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  const bytes = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseResponse<T>(
  response: unknown,
  schema: z.ZodType<T>,
  label: string,
) {
  const result = schema.safeParse(response);
  if (!result.success)
    throw new Error(`Google Drive ${label} response is invalid.`);
  return result.data;
}

function statusError(action: string, status: number) {
  return new Error(`Google Drive ${action} failed (HTTP ${status}).`);
}

async function driveRequest(
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
    throw new Error("Google Drive archive request failed.");
  }
  if (!response.ok && !(allowConflict && response.status === 409))
    throw statusError("archive request", response.status);
  return response;
}

async function ensureWritableFolder(access: DriveAccess, fetcher: DriveFetch) {
  const folderId = validateFolderId(access.folderId);
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
    throw new Error("Google Drive archive folder response is invalid.", {
      cause: error,
    });
  }
  const folder = parseResponse(payload, driveFolderSchema, "archive folder");
  if (
    folder.id !== folderId ||
    folder.mimeType !== GOOGLE_DRIVE_FOLDER_MIME_TYPE ||
    folder.trashed ||
    folder.capabilities?.canAddChildren !== true
  )
    throw new Error("Google Drive snapshot archive folder is not writable.");
  return folderId;
}

/**
 * Creates an archive port for the user's selected Drive folder. OAuth access
 * is resolved per project so every scheduled write uses that workspace's
 * encrypted refresh token and selected Picker folder. Only the already
 * encrypted snapshot envelope is uploaded.
 */
export function createGoogleDriveProjectSettingsSnapshotArchive(
  input: {
    resolveAccess?: (projectId: string) => Promise<DriveAccess>;
    fetcher?: DriveFetch;
  } = {},
): ProjectSettingsSnapshotArchivePort {
  const resolveAccess =
    input.resolveAccess ??
    (async (projectId) => {
      const { getGoogleDriveArchiveAccessForProject } =
        await import("./googleDriveArchiveOAuth");
      return getGoogleDriveArchiveAccessForProject(projectId);
    });
  const fetcher = input.fetcher ?? fetch;

  async function accessFor(projectId: string): Promise<DriveAccess> {
    const access = await resolveAccess(projectId);
    validateFolderId(access.folderId);
    if (!access.accessToken.trim())
      throw new Error("Google Drive authorization is unavailable.");
    return access;
  }

  async function findExisting(
    access: DriveAccess,
    folderId: string,
    idempotencyHash: string,
  ): Promise<z.infer<typeof driveFileSchema> | null> {
    const url = new URL(`${GOOGLE_DRIVE_API_URL}/files`);
    url.searchParams.set(
      "q",
      `'${folderId}' in parents and trashed = false and appProperties has { key='openSeoIdempotencyHash' and value='${idempotencyHash}' }`,
    );
    url.searchParams.set("pageSize", "2");
    url.searchParams.set(
      "fields",
      "files(id,appProperties,parents,trashed),incompleteSearch,nextPageToken",
    );
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    let payload: unknown;
    try {
      payload = await (
        await driveRequest(access.accessToken, fetcher, url)
      ).json();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Google Drive"))
        throw error;
      throw new Error("Google Drive archive lookup response is invalid.", {
        cause: error,
      });
    }
    const result = parseResponse(payload, driveListSchema, "archive lookup");
    if (result.incompleteSearch || result.nextPageToken)
      throw new Error("Google Drive archive lookup was incomplete.");
    if (result.files.length > 1)
      throw new Error(
        "Google Drive archive contains duplicate snapshot records.",
      );
    return result.files[0] ?? null;
  }

  async function getFileById(access: DriveAccess, fileId: string) {
    const url = new URL(
      `${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("fields", "id,appProperties,parents,trashed");
    url.searchParams.set("supportsAllDrives", "true");
    let payload: unknown;
    try {
      payload = await (
        await driveRequest(access.accessToken, fetcher, url)
      ).json();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Google Drive"))
        throw error;
      throw new Error("Google Drive archive file response is invalid.", {
        cause: error,
      });
    }
    return parseResponse(payload, driveFileSchema, "archive file");
  }

  async function verifyStoredFile(details: {
    access: DriveAccess;
    folderId: string;
    file: z.infer<typeof driveFileSchema>;
    snapshot: EncryptedProjectSettingsSnapshot;
    idempotencyHash: string;
    payloadHash: string;
  }) {
    const { access, folderId, file, snapshot, idempotencyHash, payloadHash } =
      details;
    const properties = file.appProperties ?? {};
    if (file.trashed)
      throw new Error("Google Drive snapshot file is in the trash.");
    if (
      properties.openSeoIdempotencyHash !== idempotencyHash ||
      properties.openSeoPayloadSha256 !== payloadHash ||
      properties.openSeoProjectId !== snapshot.projectId ||
      properties.openSeoRevision !== String(snapshot.revision)
    )
      throw new Error(
        "Google Drive snapshot idempotency key has different data.",
      );
    if (!file.parents?.includes(folderId))
      throw new Error(
        "Google Drive snapshot is not in the configured archive folder.",
      );

    const url = new URL(
      `${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(file.id)}`,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    const response = await driveRequest(access.accessToken, fetcher, url);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new Error("Google Drive snapshot could not be read back.");
    }
    if ((await sha256Hex(bytes)) !== payloadHash)
      throw new Error(
        "Google Drive snapshot read-back integrity check failed.",
      );
  }

  return {
    async generateFileId(projectId: string) {
      const access = await accessFor(projectId);
      await ensureWritableFolder(access, fetcher);
      const url = new URL(`${GOOGLE_DRIVE_API_URL}/files/generateIds`);
      url.searchParams.set("count", "1");
      url.searchParams.set("space", "drive");
      url.searchParams.set("type", "files");
      let payload: unknown;
      try {
        payload = await (
          await driveRequest(access.accessToken, fetcher, url)
        ).json();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Google Drive"))
          throw error;
        throw new Error("Google Drive generated ID response is invalid.", {
          cause: error,
        });
      }
      const result = parseResponse(
        payload,
        driveGeneratedIdsSchema,
        "generated ID",
      );
      return validateGeneratedFileId(result.ids[0] ?? "");
    },
    async putEncryptedSnapshot(snapshot, fileId) {
      const reservedFileId = validateGeneratedFileId(fileId);
      const access = await accessFor(snapshot.projectId);
      const folderId = await ensureWritableFolder(access, fetcher);
      const payload = JSON.stringify({
        algorithm: snapshot.algorithm,
        schemaVersion: snapshot.schemaVersion,
        iv: snapshot.iv,
        ciphertext: snapshot.ciphertext,
      });
      const payloadBytes = new TextEncoder().encode(payload);
      const [idempotencyHash, payloadHash] = await Promise.all([
        sha256Hex(new TextEncoder().encode(snapshot.idempotencyKey)),
        sha256Hex(payloadBytes),
      ]);
      const existing = await findExisting(access, folderId, idempotencyHash);
      if (existing) {
        await verifyStoredFile({
          access,
          folderId,
          file: existing,
          snapshot,
          idempotencyHash,
          payloadHash,
        });
        return;
      }

      const boundary = `open-seo-${crypto.randomUUID()}`;
      const metadata = {
        id: reservedFileId,
        name: `open-seo-project-settings-${idempotencyHash.slice(0, 24)}.json`,
        mimeType: "application/json",
        parents: [folderId],
        appProperties: {
          openSeoIdempotencyHash: idempotencyHash,
          openSeoPayloadSha256: payloadHash,
          openSeoProjectId: snapshot.projectId,
          openSeoRevision: String(snapshot.revision),
        },
      };
      const multipartBody = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(metadata),
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        payload,
        `--${boundary}--`,
        "",
      ].join("\r\n");
      const url = new URL(`${GOOGLE_DRIVE_UPLOAD_URL}/files`);
      url.searchParams.set("uploadType", "multipart");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("fields", "id,appProperties,parents,trashed");
      const response = await driveRequest(
        access.accessToken,
        fetcher,
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        },
        true,
      );
      if (response.status === 409) {
        const existingById = await getFileById(access, reservedFileId);
        await verifyStoredFile({
          access,
          folderId,
          file: existingById,
          snapshot,
          idempotencyHash,
          payloadHash,
        });
        return;
      }
      let createdPayload: unknown;
      try {
        createdPayload = await response.json();
      } catch {
        throw new Error("Google Drive upload response is invalid.");
      }
      const created = parseResponse(
        createdPayload,
        driveCreateSchema,
        "upload",
      );
      if (created.id !== reservedFileId)
        throw new Error("Google Drive created a different snapshot ID.");
      await verifyStoredFile({
        access,
        folderId,
        file: created,
        snapshot,
        idempotencyHash,
        payloadHash,
      });
    },
  };
}

/** Returns null when OAuth is deliberately not configured for this install. */
export async function getConfiguredGoogleDriveProjectSettingsSnapshotArchive() {
  const { isGoogleDriveArchiveOAuthConfigured } =
    await import("./googleDriveArchiveOAuth");
  if (!(await isGoogleDriveArchiveOAuthConfigured())) return null;
  return createGoogleDriveProjectSettingsSnapshotArchive();
}
