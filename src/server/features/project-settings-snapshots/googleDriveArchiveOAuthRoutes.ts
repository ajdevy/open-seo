import { and, eq, isNull, notExists, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { hasOrgPermission } from "@/lib/org-permissions";
import { googleDriveArchiveConnections } from "@/db/schema";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import {
  lockGoogleDriveArchiveConnectionTarget,
  targetBoundPendingSnapshotQuery,
} from "./archiveTargetRepository";
import { hasTargetBoundPendingProjectSettingsSnapshots } from "./snapshotRepository";
import {
  accessTokenForConnection,
  connectionForOrganization,
  verifySelectedFolder,
} from "./googleDriveArchiveOAuth";
import { completeGoogleDriveArchiveOAuth } from "./googleDriveArchiveOAuthCallback";
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
  if (!hasOrgPermission(context.role, { integration: ["manage"] }))
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

const oauthCompletionSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/u),
    browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    code: z.string().min(1).max(4096).optional(),
    authorizationDenied: z.boolean().default(false),
  })
  .refine(
    (value) => value.authorizationDenied || typeof value.code === "string",
  );

async function completeOAuthRequest(
  request: Request,
  config: DriveArchiveConfig,
  context: Awaited<ReturnType<typeof requireAdmin>>,
) {
  const input = oauthCompletionSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!input.success) return genericError(400, "invalid_oauth_completion");
  return completeGoogleDriveArchiveOAuth({
    config,
    context,
    stateToken: input.data.state,
    browserBinding: input.data.browserBinding,
    code: input.data.code,
    authorizationDenied: input.data.authorizationDenied,
  });
}

async function handleFolderRequest(
  request: Request,
  context: Awaited<ReturnType<typeof requireAdmin>>,
  config: DriveArchiveConfig,
) {
  const connection = await connectionForOrganization(context.organizationId);
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
  await runBatch((tx) => [
    lockGoogleDriveArchiveConnectionTarget(tx, {
      connectionId: connection.id,
      organizationId: connection.organizationId,
      googleAccountId: connection.googleAccountId,
      folderId: connection.folderId,
    }),
    tx
      .update(googleDriveArchiveConnections)
      .set({
        folderId: folder.id,
        folderName: folder.name,
        status: "connected",
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(googleDriveArchiveConnections.id, connection.id),
          eq(
            googleDriveArchiveConnections.organizationId,
            connection.organizationId,
          ),
          eq(
            googleDriveArchiveConnections.googleAccountId,
            connection.googleAccountId,
          ),
          eq(googleDriveArchiveConnections.status, "connected"),
          connection.folderId === null
            ? isNull(googleDriveArchiveConnections.folderId)
            : eq(googleDriveArchiveConnections.folderId, connection.folderId),
          or(
            eq(googleDriveArchiveConnections.folderId, folder.id),
            notExists(
              targetBoundPendingSnapshotQuery(tx, context.organizationId),
            ),
          ),
        ),
      ),
  ]);
  const current = await connectionForOrganization(context.organizationId);
  if (
    current?.id !== connection.id ||
    current.googleAccountId !== connection.googleAccountId ||
    current.folderId !== folder.id
  )
    return genericError(409, "archive_target_change_blocked");
  return jsonResponse({ folder: { id: folder.id, name: folder.name } });
}

async function handleDisconnectRequest(
  context: Awaited<ReturnType<typeof requireAdmin>>,
  config: DriveArchiveConfig,
) {
  const connection = await connectionForOrganization(context.organizationId);
  if (!connection) return jsonResponse({ disconnected: true });
  const cipher = await tokenCipher(config);
  let refreshToken: string | null = null;
  try {
    refreshToken = await cipher.decrypt(
      connection.refreshTokenCiphertext,
      googleDriveTokenContext(
        config,
        connection.organizationId,
        connection.googleAccountId,
        "refresh",
      ),
    );
  } catch {
    // Local removal remains authoritative; Google can be revoked manually.
  }

  await runBatch((tx) => [
    lockGoogleDriveArchiveConnectionTarget(tx, {
      connectionId: connection.id,
      organizationId: connection.organizationId,
      googleAccountId: connection.googleAccountId,
      folderId: connection.folderId,
    }),
    tx
      .delete(googleDriveArchiveConnections)
      .where(
        and(
          eq(googleDriveArchiveConnections.id, connection.id),
          eq(
            googleDriveArchiveConnections.organizationId,
            connection.organizationId,
          ),
          eq(
            googleDriveArchiveConnections.googleAccountId,
            connection.googleAccountId,
          ),
          connection.folderId === null
            ? isNull(googleDriveArchiveConnections.folderId)
            : eq(googleDriveArchiveConnections.folderId, connection.folderId),
          notExists(
            targetBoundPendingSnapshotQuery(tx, context.organizationId),
          ),
        ),
      ),
  ]);
  const [stillConnected] = await db
    .select({ id: googleDriveArchiveConnections.id })
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.id, connection.id))
    .limit(1);
  if (stillConnected) return genericError(409, "archive_target_change_blocked");

  let revoked = false;
  if (refreshToken) {
    try {
      const response = await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      revoked = response.ok || response.status === 400;
    } catch {
      // Local removal remains authoritative; Google can be revoked manually.
    }
  }
  return jsonResponse({ disconnected: true, googleRevoked: revoked });
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
      const authorization = await createAuthorizationUrl({
        config,
        context: {
          userId: context.userId,
          organizationId: context.organizationId,
        },
      });
      return jsonResponse(authorization);
    }

    if (
      url.pathname === `${API_ROOT}/oauth/complete` &&
      request.method === "POST"
    ) {
      const response = await completeOAuthRequest(request, config, context);
      return response;
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
      const response = await handleFolderRequest(request, context, config);
      return response;
    }

    if (
      url.pathname === `${API_ROOT}/connection` &&
      request.method === "DELETE"
    ) {
      const response = await handleDisconnectRequest(context, config);
      return response;
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
