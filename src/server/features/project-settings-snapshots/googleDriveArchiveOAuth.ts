import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { googleDriveArchiveConnections, projects } from "@/db/schema";
import { hasTargetBoundPendingProjectSettingsSnapshots } from "./snapshotRepository";
import { targetBoundPendingSnapshotQuery } from "./archiveTargetRepository";
import {
  GOOGLE_DRIVE_FILES_URL,
  OAUTH_SCOPES,
  GOOGLE_TOKEN_URL,
  REQUEST_TIMEOUT_MS,
  TOKEN_SKEW_MS,
  driveFolderSchema,
  readConfig,
  tokenCipher,
  tokenResponseSchema,
  googleDriveTokenContext,
  type DriveArchiveConfig,
  type GoogleDriveArchiveOAuthState,
} from "./googleDriveArchiveOAuthShared";

export async function saveConnection(input: {
  config: DriveArchiveConfig;
  state: GoogleDriveArchiveOAuthState;
  tokens: z.infer<typeof tokenResponseSchema>;
  googleAccountId: string;
  accountEmail: string;
}) {
  const cipher = await tokenCipher(input.config);
  const [existing] = await db
    .select({
      googleAccountId: googleDriveArchiveConnections.googleAccountId,
      refreshTokenCiphertext:
        googleDriveArchiveConnections.refreshTokenCiphertext,
    })
    .from(googleDriveArchiveConnections)
    .where(
      eq(
        googleDriveArchiveConnections.organizationId,
        input.state.organizationId,
      ),
    )
    .limit(1);
  if (
    existing?.googleAccountId !== input.googleAccountId &&
    (await hasTargetBoundPendingProjectSettingsSnapshots(
      input.state.organizationId,
    ))
  )
    throw new Error("google_drive_archive_target_change_blocked");
  const refreshTokenCiphertext = input.tokens.refresh_token
    ? await cipher.encrypt(
        input.tokens.refresh_token,
        googleDriveTokenContext(
          input.config,
          input.state.organizationId,
          input.googleAccountId,
          "refresh",
        ),
      )
    : existing?.googleAccountId === input.googleAccountId
      ? existing.refreshTokenCiphertext
      : undefined;
  if (!refreshTokenCiphertext)
    throw new Error("Google did not return a durable Drive authorization.");

  const now = new Date().toISOString();
  const values = {
    id: crypto.randomUUID(),
    organizationId: input.state.organizationId,
    connectedByUserId: input.state.userId,
    googleAccountId: input.googleAccountId,
    accountEmail: input.accountEmail,
    accessTokenCiphertext: await cipher.encrypt(
      input.tokens.access_token,
      googleDriveTokenContext(
        input.config,
        input.state.organizationId,
        input.googleAccountId,
        "access",
      ),
    ),
    refreshTokenCiphertext,
    accessTokenExpiresAt: new Date(
      Date.now() + input.tokens.expires_in * 1_000,
    ).toISOString(),
    scope: input.tokens.scope ?? OAUTH_SCOPES.join(" "),
    folderId: null as string | null,
    folderName: null as string | null,
    status: "connected" as const,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(googleDriveArchiveConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [googleDriveArchiveConnections.organizationId],
      set: {
        connectedByUserId: values.connectedByUserId,
        googleAccountId: values.googleAccountId,
        accountEmail: values.accountEmail,
        accessTokenCiphertext: values.accessTokenCiphertext,
        ...(input.tokens.refresh_token ? { refreshTokenCiphertext } : {}),
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        scope: values.scope,
        folderId: sql`case
          when ${googleDriveArchiveConnections.googleAccountId} = ${input.googleAccountId}
          then ${googleDriveArchiveConnections.folderId}
          else null
        end`,
        folderName: sql`case
          when ${googleDriveArchiveConnections.googleAccountId} = ${input.googleAccountId}
          then ${googleDriveArchiveConnections.folderName}
          else null
        end`,
        status: "connected",
        updatedAt: now,
      },
      setWhere: or(
        eq(
          googleDriveArchiveConnections.googleAccountId,
          input.googleAccountId,
        ),
        notExists(
          targetBoundPendingSnapshotQuery(db, input.state.organizationId),
        ),
      ),
    });
  const [saved] = await db
    .select({ googleAccountId: googleDriveArchiveConnections.googleAccountId })
    .from(googleDriveArchiveConnections)
    .where(
      eq(
        googleDriveArchiveConnections.organizationId,
        input.state.organizationId,
      ),
    )
    .limit(1);
  if (saved?.googleAccountId !== input.googleAccountId)
    throw new Error("google_drive_archive_target_change_blocked");
}

export async function connectionForOrganization(organizationId: string) {
  const [connection] = await db
    .select()
    .from(googleDriveArchiveConnections)
    .where(eq(googleDriveArchiveConnections.organizationId, organizationId))
    .limit(1);
  return connection ?? null;
}

export async function accessTokenForConnection(
  connection: NonNullable<
    Awaited<ReturnType<typeof connectionForOrganization>>
  >,
  config: DriveArchiveConfig,
): Promise<string> {
  if (connection.status !== "connected")
    throw new Error("Google Drive authorization needs reconnection.");
  const cipher = await tokenCipher(config);
  const accessContext = googleDriveTokenContext(
    config,
    connection.organizationId,
    connection.googleAccountId,
    "access",
  );
  const refreshContext = googleDriveTokenContext(
    config,
    connection.organizationId,
    connection.googleAccountId,
    "refresh",
  );
  if (Date.parse(connection.accessTokenExpiresAt) > Date.now() + TOKEN_SKEW_MS)
    return cipher.decrypt(connection.accessTokenCiphertext, accessContext);
  const refreshToken = await cipher.decrypt(
    connection.refreshTokenCiphertext,
    refreshContext,
  );
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A malformed provider response stays a retryable failure.
  }
  if (!response.ok) {
    const providerError =
      typeof payload === "object" && payload !== null && "error" in payload
        ? payload.error
        : null;
    if (providerError === "invalid_grant")
      await db
        .update(googleDriveArchiveConnections)
        .set({
          status: "reauthorization_required",
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
            eq(
              googleDriveArchiveConnections.refreshTokenCiphertext,
              connection.refreshTokenCiphertext,
            ),
            eq(
              googleDriveArchiveConnections.accessTokenExpiresAt,
              connection.accessTokenExpiresAt,
            ),
            eq(googleDriveArchiveConnections.status, "connected"),
          ),
        );
    throw new Error("Google Drive authorization refresh failed.");
  }
  const tokens = tokenResponseSchema.safeParse(payload);
  if (!tokens.success)
    throw new Error("Google Drive authorization response is invalid.");
  const encryptedAccessToken = await cipher.encrypt(
    tokens.data.access_token,
    accessContext,
  );
  const expiresAt = new Date(
    Date.now() + tokens.data.expires_in * 1_000,
  ).toISOString();
  const [updatedConnection] = await db
    .update(googleDriveArchiveConnections)
    .set({
      accessTokenCiphertext: encryptedAccessToken,
      accessTokenExpiresAt: expiresAt,
      ...(tokens.data.refresh_token
        ? {
            refreshTokenCiphertext: await cipher.encrypt(
              tokens.data.refresh_token,
              refreshContext,
            ),
          }
        : {}),
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
        eq(
          googleDriveArchiveConnections.refreshTokenCiphertext,
          connection.refreshTokenCiphertext,
        ),
        eq(
          googleDriveArchiveConnections.accessTokenExpiresAt,
          connection.accessTokenExpiresAt,
        ),
        eq(googleDriveArchiveConnections.status, "connected"),
        connection.folderId === null
          ? isNull(googleDriveArchiveConnections.folderId)
          : eq(googleDriveArchiveConnections.folderId, connection.folderId),
      ),
    )
    .returning({ id: googleDriveArchiveConnections.id });
  if (!updatedConnection)
    throw new Error("Google Drive connection changed during token refresh.");
  return tokens.data.access_token;
}

export async function getGoogleDriveArchiveAccessForProject(projectId: string) {
  const [project] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project settings snapshot has no project.");
  const config = await readConfig();
  if (!config) throw new Error("Google Drive archive is not configured.");
  const connection = await connectionForOrganization(project.organizationId);
  if (!connection?.folderId)
    throw new Error("Google Drive archive folder has not been selected.");
  return {
    target: {
      connectionId: connection.id,
      organizationId: connection.organizationId,
      googleAccountId: connection.googleAccountId,
      folderId: connection.folderId,
    },
    folderId: connection.folderId,
    accessToken: await accessTokenForConnection(connection, config),
  };
}

export async function getGoogleDriveArchiveAccessForOrganization(
  organizationId: string,
) {
  const config = await readConfig();
  if (!config) throw new Error("Google Drive archive is not configured.");
  const connection = await connectionForOrganization(organizationId);
  if (!connection?.folderId)
    throw new Error("Google Drive archive folder has not been selected.");
  return {
    target: {
      connectionId: connection.id,
      organizationId: connection.organizationId,
      googleAccountId: connection.googleAccountId,
      folderId: connection.folderId,
    },
    folderId: connection.folderId,
    accessToken: await accessTokenForConnection(connection, config),
  };
}

export async function isGoogleDriveArchiveOAuthConfigured() {
  return Boolean(await readConfig());
}

export async function verifySelectedFolder(
  accessToken: string,
  folderId: string,
) {
  const url = new URL(
    `${GOOGLE_DRIVE_FILES_URL}/${encodeURIComponent(folderId)}`,
  );
  url.searchParams.set(
    "fields",
    "id,name,mimeType,trashed,capabilities(canAddChildren)",
  );
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error("Google Drive folder could not be verified.");
  const folder = driveFolderSchema.parse(await response.json());
  if (
    folder.id !== folderId ||
    folder.mimeType !== "application/vnd.google-apps.folder" ||
    folder.trashed ||
    folder.capabilities?.canAddChildren !== true
  )
    throw new Error("Selected Google Drive folder is not writable.");
  return folder;
}
