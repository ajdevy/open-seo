import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { googleDriveArchiveConnections } from "@/db/schema";
import {
  readConfig,
  tokenCipher,
  googleDriveTokenContext,
} from "../features/project-settings-snapshots/googleDriveArchiveOAuthShared";
import { SHARED_WORKSPACE_ORGANIZATION_ID } from "./delegated-organization";
import { AppError } from "@/server/lib/errors";

export type WorkspaceArchiveConnectionTransfer = {
  id: string;
  organizationId: string;
  updatedAt: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
};

/**
 * Prepares the only archive connection that can be safely adopted by the
 * shared workspace. Token ciphertext is bound to its organization ID, so the
 * credentials must be re-encrypted before the atomic organization move.
 */
export async function prepareWorkspaceArchiveConnectionTransfer(
  legacyOrganizationIds: string[],
): Promise<WorkspaceArchiveConnectionTransfer | undefined> {
  const connections = await db
    .select({
      id: googleDriveArchiveConnections.id,
      organizationId: googleDriveArchiveConnections.organizationId,
      updatedAt: googleDriveArchiveConnections.updatedAt,
      googleAccountId: googleDriveArchiveConnections.googleAccountId,
      accessTokenCiphertext:
        googleDriveArchiveConnections.accessTokenCiphertext,
      refreshTokenCiphertext:
        googleDriveArchiveConnections.refreshTokenCiphertext,
    })
    .from(googleDriveArchiveConnections)
    .where(
      inArray(googleDriveArchiveConnections.organizationId, [
        SHARED_WORKSPACE_ORGANIZATION_ID,
        ...legacyOrganizationIds,
      ]),
    );
  if (connections.length > 1)
    throw new AppError(
      "CONFLICT",
      "Resolve multiple Google Drive archive destinations before merging workspaces.",
    );

  const connection = connections[0];
  if (
    !connection ||
    connection.organizationId === SHARED_WORKSPACE_ORGANIZATION_ID
  )
    return undefined;

  try {
    const config = await readConfig();
    if (!config) throw new Error("Drive archive configuration is unavailable.");
    const cipher = await tokenCipher(config);
    const [accessToken, refreshToken] = await Promise.all([
      cipher.decrypt(
        connection.accessTokenCiphertext,
        googleDriveTokenContext(
          config,
          connection.organizationId,
          connection.googleAccountId,
          "access",
        ),
      ),
      cipher.decrypt(
        connection.refreshTokenCiphertext,
        googleDriveTokenContext(
          config,
          connection.organizationId,
          connection.googleAccountId,
          "refresh",
        ),
      ),
    ]);
    return {
      id: connection.id,
      organizationId: connection.organizationId,
      updatedAt: connection.updatedAt,
      accessTokenCiphertext: await cipher.encrypt(
        accessToken,
        googleDriveTokenContext(
          config,
          SHARED_WORKSPACE_ORGANIZATION_ID,
          connection.googleAccountId,
          "access",
        ),
      ),
      refreshTokenCiphertext: await cipher.encrypt(
        refreshToken,
        googleDriveTokenContext(
          config,
          SHARED_WORKSPACE_ORGANIZATION_ID,
          connection.googleAccountId,
          "refresh",
        ),
      ),
    };
  } catch {
    throw new AppError(
      "CONFLICT",
      "Google Drive archive credentials cannot be preserved; restore the archive configuration before merging workspaces.",
    );
  }
}
