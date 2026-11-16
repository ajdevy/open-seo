import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { googleDriveArchiveConnections, projects } from "@/db/schema";
import { getGoogleAccountId } from "@/server/features/google/googleIdToken";
import { hasTargetBoundPendingProjectSettingsSnapshots } from "./snapshotRepository";
import {
  GOOGLE_DRIVE_FILES_URL,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  OAUTH_SCOPES,
  REQUEST_TIMEOUT_MS,
  TOKEN_SKEW_MS,
  codeVerifier,
  consumeState,
  driveFolderSchema,
  genericError,
  googleTokenRequest,
  readConfig,
  redirect,
  tokenCipher,
  tokenResponseSchema,
  googleDriveTokenContext,
  userInfoSchema,
  type DriveArchiveConfig,
  type GoogleDriveArchiveOAuthState,
} from "./googleDriveArchiveOAuthShared";

async function saveConnection(input: {
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
  const [current] = await db
    .select({
      googleAccountId: googleDriveArchiveConnections.googleAccountId,
      folderId: googleDriveArchiveConnections.folderId,
      folderName: googleDriveArchiveConnections.folderName,
    })
    .from(googleDriveArchiveConnections)
    .where(
      eq(
        googleDriveArchiveConnections.organizationId,
        input.state.organizationId,
      ),
    )
    .limit(1);
  await db
    .insert(googleDriveArchiveConnections)
    .values({
      ...values,
      folderId:
        current?.googleAccountId === input.googleAccountId
          ? current.folderId
          : null,
      folderName:
        current?.googleAccountId === input.googleAccountId
          ? current.folderName
          : null,
    })
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
        folderId:
          current?.googleAccountId === input.googleAccountId
            ? current.folderId
            : null,
        folderName:
          current?.googleAccountId === input.googleAccountId
            ? current.folderName
            : null,
        status: "connected",
        updatedAt: now,
      },
    });
}

function callbackReturn(code: "connected" | "failed" | "pending-snapshots") {
  return `/settings?googleDriveArchive=${code}`;
}

export async function handleGoogleDriveArchiveOAuthCallback(
  request: Request,
): Promise<Response> {
  try {
    const config = await readConfig();
    if (!config) return redirect(callbackReturn("failed"));
    const requestUrl = new URL(request.url);
    if (`${requestUrl.origin}${requestUrl.pathname}` !== config.redirectUri)
      return genericError(400, "invalid_callback");
    const rawState = requestUrl.searchParams.get("state");
    const state = await consumeState(rawState);
    if (!state || state.redirectUri !== config.redirectUri)
      return redirect(callbackReturn("failed"));
    if (requestUrl.searchParams.has("error"))
      return redirect(callbackReturn("failed"));
    const code = requestUrl.searchParams.get("code");
    if (!code) return redirect(callbackReturn("failed"));
    const verifier = await codeVerifier(rawState!, config.clientSecret);
    const { tokens } = await googleTokenRequest({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    });
    if (!tokens || !tokens.id_token) return redirect(callbackReturn("failed"));
    const scopes = new Set((tokens.scope ?? "").split(/\s+/u).filter(Boolean));
    if (
      !scopes.has(GOOGLE_DRIVE_SCOPE) ||
      !scopes.has("openid") ||
      !scopes.has("email")
    )
      return redirect(callbackReturn("failed"));
    const googleAccountId = await getGoogleAccountId(
      tokens.id_token,
      config.clientId,
    );
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!userInfoResponse.ok) return redirect(callbackReturn("failed"));
    const userInfo = userInfoSchema.parse(await userInfoResponse.json());
    if (!userInfo.email_verified || userInfo.sub !== googleAccountId)
      return redirect(callbackReturn("failed"));
    await saveConnection({
      config,
      state,
      tokens,
      googleAccountId,
      accountEmail: userInfo.email,
    });
    return redirect(callbackReturn("connected"));
  } catch (error) {
    // OAuth response details and token values must never enter logs.
    if (
      error instanceof Error &&
      error.message === "google_drive_archive_target_change_blocked"
    )
      return redirect(callbackReturn("pending-snapshots"));
    return redirect(callbackReturn("failed"));
  }
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
        .where(eq(googleDriveArchiveConnections.id, connection.id));
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
  await db
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
    .where(eq(googleDriveArchiveConnections.id, connection.id));
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
