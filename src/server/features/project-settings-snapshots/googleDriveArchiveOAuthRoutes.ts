import { eq } from "drizzle-orm";
import { db } from "@/db";
import { googleDriveArchiveConnections } from "@/db/schema";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { hasTargetBoundPendingProjectSettingsSnapshots } from "./snapshotRepository";
import {
  accessTokenForConnection,
  connectionForOrganization,
  verifySelectedFolder,
} from "./googleDriveArchiveOAuth";
import {
  API_ROOT,
  GOOGLE_DRIVE_ARCHIVE_CALLBACK_PATH,
  GOOGLE_REVOKE_URL,
  REQUEST_TIMEOUT_MS,
  createAuthorizationUrl,
  type DriveArchiveConfig,
  folderSelectionSchema,
  genericError,
  jsonResponse,
  googleDriveTokenContext,
  readConfig,
  tokenCipher,
} from "./googleDriveArchiveOAuthShared";

async function requireAdmin(request: Request) {
  const context = await resolveUserContextFromHeaders(request.headers);
  if (context.role !== "owner" && context.role !== "admin")
    throw new Error("forbidden");
  return context;
}

function requestHasSameOrigin(request: Request, config: DriveArchiveConfig) {
  const expectedOrigin = new URL(config.redirectUri).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== expectedOrigin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  const isSafeRead = request.method === "GET" || request.method === "HEAD";
  if (!isSafeRead && origin !== expectedOrigin) return false;
  return (
    !fetchSite ||
    fetchSite === "same-origin" ||
    (isSafeRead && fetchSite === "none")
  );
}

function requirePickerConfig(config: DriveArchiveConfig) {
  if (!config.pickerApiKey || !config.projectNumber)
    throw new Error("Google Drive Picker is not configured.");
  return { apiKey: config.pickerApiKey, projectNumber: config.projectNumber };
}

async function handleApiRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === GOOGLE_DRIVE_ARCHIVE_CALLBACK_PATH) return null;
  if (!url.pathname.startsWith(`${API_ROOT}/`) && url.pathname !== API_ROOT)
    return null;
  let context: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    context = await requireAdmin(request);
  } catch (error) {
    if (error instanceof Error && error.message === "forbidden")
      return genericError(403, "admin_required");
    return genericError(401, "authentication_required");
  }

  let config: DriveArchiveConfig | null;
  try {
    config = await readConfig();
  } catch {
    return genericError(503, "google_drive_archive_configuration_invalid");
  }
  if (!config) return genericError(503, "google_drive_archive_not_configured");
  if (!requestHasSameOrigin(request, config))
    return genericError(403, "same_origin_required");

  try {
    if (url.pathname === `${API_ROOT}/status` && request.method === "GET") {
      const connection = await connectionForOrganization(
        context.organizationId,
      );
      return jsonResponse({
        configured: true,
        connected: Boolean(connection),
        status: connection?.status ?? null,
        accountEmail: connection?.accountEmail ?? null,
        folder: connection?.folderId
          ? { id: connection.folderId, name: connection.folderName }
          : null,
        pickerReady: Boolean(config.pickerApiKey && config.projectNumber),
      });
    }

    if (
      url.pathname === `${API_ROOT}/oauth/start` &&
      request.method === "POST"
    ) {
      if (!config.pickerApiKey || !config.projectNumber)
        return genericError(503, "google_drive_picker_not_configured");
      if (url.origin !== new URL(config.redirectUri).origin)
        return genericError(403, "origin_mismatch");
      const location = await createAuthorizationUrl({
        config,
        context: {
          userId: context.userId,
          organizationId: context.organizationId,
        },
      });
      return jsonResponse({ authorizationUrl: location });
    }

    if (
      url.pathname === `${API_ROOT}/picker-token` &&
      request.method === "POST"
    ) {
      const picker = requirePickerConfig(config);
      const connection = await connectionForOrganization(
        context.organizationId,
      );
      if (!connection) return genericError(409, "google_drive_not_connected");
      const accessToken = await accessTokenForConnection(connection, config);
      return jsonResponse({ ...picker, accessToken });
    }

    if (url.pathname === `${API_ROOT}/folder` && request.method === "PUT") {
      const connection = await connectionForOrganization(
        context.organizationId,
      );
      if (!connection) return genericError(409, "google_drive_not_connected");
      const input = folderSelectionSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!input.success) return genericError(400, "invalid_folder_selection");
      if (
        input.data.id !== connection.folderId &&
        (await hasTargetBoundPendingProjectSettingsSnapshots(
          context.organizationId,
        ))
      )
        return genericError(409, "archive_target_change_blocked");
      const accessToken = await accessTokenForConnection(connection, config);
      const folder = await verifySelectedFolder(accessToken, input.data.id);
      await db
        .update(googleDriveArchiveConnections)
        .set({
          folderId: folder.id,
          folderName: folder.name,
          status: "connected",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(googleDriveArchiveConnections.id, connection.id));
      return jsonResponse({ folder: { id: folder.id, name: folder.name } });
    }

    if (
      url.pathname === `${API_ROOT}/connection` &&
      request.method === "DELETE"
    ) {
      const connection = await connectionForOrganization(
        context.organizationId,
      );
      if (!connection) return jsonResponse({ disconnected: true });
      if (
        await hasTargetBoundPendingProjectSettingsSnapshots(
          context.organizationId,
        )
      )
        return genericError(409, "archive_target_change_blocked");
      const cipher = await tokenCipher(config);
      let revoked = false;
      try {
        const token = await cipher.decrypt(
          connection.refreshTokenCiphertext,
          googleDriveTokenContext(
            config,
            connection.organizationId,
            connection.googleAccountId,
            "refresh",
          ),
        );
        const response = await fetch(GOOGLE_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        revoked = response.ok || response.status === 400;
      } catch {
        // Local removal remains authoritative; Google can be revoked manually.
      }
      await db
        .delete(googleDriveArchiveConnections)
        .where(eq(googleDriveArchiveConnections.id, connection.id));
      return jsonResponse({ disconnected: true, googleRevoked: revoked });
    }

    return genericError(404, "not_found");
  } catch {
    return genericError(503, "google_drive_archive_request_failed");
  }
}

export async function handleGoogleDriveArchiveRequest(
  request: Request,
): Promise<Response | null> {
  return handleApiRequest(request);
}
