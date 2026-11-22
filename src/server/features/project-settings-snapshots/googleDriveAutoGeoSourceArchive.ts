import type { AutoGeoSourceArchivePort } from "@/server/standalone/autogeo-source-archive";
import {
  GOOGLE_DRIVE_API_URL,
  GOOGLE_DRIVE_UPLOAD_URL,
  createDriveArchiveHelpers,
  driveFileSchema,
  generatedIdsSchema,
  parseEnvelope,
  parseResponse,
  serializeEnvelope,
  sha256Hex,
  driveRequest,
  validateDriveId,
  type DriveAccess,
  type DriveFetch,
} from "./googleDriveAutoGeoSourceArchiveShared";

/**
 * Binds every archive operation to the same OAuth connection, Google account,
 * and user-selected Picker folder that was durably reserved in the outbox.
 */
export function createGoogleDriveAutoGeoSourceArchivePort(
  input: {
    resolveAccess?: (organizationId: string) => Promise<DriveAccess>;
    fetcher?: DriveFetch;
  } = {},
): AutoGeoSourceArchivePort {
  const resolveAccess =
    input.resolveAccess ??
    (async (organizationId) => {
      const { getGoogleDriveArchiveAccessForOrganization } =
        await import("./googleDriveArchiveOAuth");
      return getGoogleDriveArchiveAccessForOrganization(organizationId);
    });
  const fetcher = input.fetcher ?? fetch;

  const {
    accessFor,
    ensureWritableFolder,
    findExisting,
    getFileById,
    verifiedExisting,
  } = createDriveArchiveHelpers({ resolveAccess, fetcher });

  return {
    async generateFileId(organizationId) {
      const access = await accessFor(organizationId);
      await ensureWritableFolder(access);
      const url = new URL(`${GOOGLE_DRIVE_API_URL}/files/generateIds`);
      url.searchParams.set("count", "1");
      url.searchParams.set("space", "drive");
      url.searchParams.set("type", "files");
      const result = parseResponse(
        await (await driveRequest(access.accessToken, fetcher, url)).json(),
        generatedIdsSchema,
        "generated ID response",
      );
      return {
        fileId: validateDriveId(result.ids[0] ?? ""),
        target: access.target,
      };
    },

    async putEncryptedSourceArchive(envelope, fileId, target) {
      const reservedFileId = validateDriveId(fileId);
      const access = await accessFor(target.organizationId, target);
      const folderId = await ensureWritableFolder(access);
      const payload = serializeEnvelope(envelope);
      const payloadBytes = new TextEncoder().encode(payload);
      const [idempotencyHash, clientRefHash, payloadHash] = await Promise.all([
        sha256Hex(new TextEncoder().encode(envelope.idempotencyKey)),
        sha256Hex(new TextEncoder().encode(envelope.clientRef)),
        sha256Hex(payloadBytes),
      ]);
      const expected = {
        fileId: reservedFileId,
        idempotencyHash,
        clientRefHash,
        payloadHash,
        sourceContractRevision: envelope.sourceContractRevision,
      };
      const existing = await findExisting(
        access,
        folderId,
        idempotencyHash,
        clientRefHash,
      );
      if (existing) {
        await verifiedExisting(access, folderId, existing, expected);
        return { fileId: existing.id };
      }

      const boundary = `open-seo-source-${crypto.randomUUID()}`;
      const metadata = {
        id: reservedFileId,
        name: `open-seo-source-${idempotencyHash.slice(0, 24)}.json`,
        mimeType: "application/json",
        parents: [folderId],
        appProperties: {
          openSeoSourceKind: "autogeo-source-migration",
          openSeoSourceIdempotencyHash: idempotencyHash,
          openSeoSourceClientRefHash: clientRefHash,
          openSeoSourcePayloadSha256: payloadHash,
          openSeoSourceRevision: envelope.sourceContractRevision,
        },
      };
      const body = [
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
          body,
        },
        true,
      );
      const created =
        response.status === 409
          ? await getFileById(access, reservedFileId)
          : parseResponse(
              await response.json(),
              driveFileSchema,
              "upload response",
            );
      if (!created)
        throw new Error("Google Drive source archive file is missing.");
      await verifiedExisting(access, folderId, created, expected);
      return { fileId: created.id };
    },

    async readEncryptedSourceArchive(
      clientRef,
      idempotencyKey,
      fileId,
      target,
    ) {
      const access = await accessFor(target.organizationId, target);
      const folderId = await ensureWritableFolder(access);
      const file = await getFileById(access, fileId);
      if (!file) return null;
      const [idempotencyHash, clientRefHash] = await Promise.all([
        sha256Hex(new TextEncoder().encode(idempotencyKey)),
        sha256Hex(new TextEncoder().encode(clientRef)),
      ]);
      const properties = file.appProperties ?? {};
      if (
        properties.openSeoSourceIdempotencyHash !== idempotencyHash ||
        properties.openSeoSourceClientRefHash !== clientRefHash ||
        properties.openSeoSourceKind !== "autogeo-source-migration"
      )
        throw new Error("Google Drive source archive lookup binding changed.");
      const payloadHash = properties.openSeoSourcePayloadSha256;
      const sourceContractRevision = properties.openSeoSourceRevision;
      if (
        !payloadHash ||
        !/^[a-f0-9]{64}$/u.test(payloadHash) ||
        !sourceContractRevision
      )
        throw new Error("Google Drive source archive metadata is invalid.");
      const storedPayload = await verifiedExisting(access, folderId, file, {
        fileId,
        idempotencyHash,
        clientRefHash,
        payloadHash,
        sourceContractRevision,
      });
      const envelope = parseEnvelope(storedPayload);
      if (
        envelope.clientRef !== clientRef ||
        envelope.idempotencyKey !== idempotencyKey ||
        envelope.sourceContractRevision !== properties.openSeoSourceRevision
      )
        throw new Error(
          "Google Drive source archive envelope binding changed.",
        );
      return { fileId, envelope };
    },
  };
}
