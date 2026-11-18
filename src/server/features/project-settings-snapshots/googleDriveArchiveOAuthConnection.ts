import { eq, notExists, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import { runBatch, runPostgresTransaction } from "@/db/runBatch";
import { googleDriveArchiveConnections } from "@/db/schema";
import {
  lockGoogleDriveArchiveConnectionForOrganization,
  targetBoundPendingSnapshotQuery,
} from "./archiveTargetRepository";
import {
  OAUTH_SCOPES,
  tokenCipher,
  googleDriveTokenContext,
  type DriveArchiveConfig,
  type GoogleDriveArchiveOAuthState,
  type tokenResponseSchema,
} from "./googleDriveArchiveOAuthShared";

type Tx = Parameters<Parameters<typeof runBatch>[0]>[0];

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
  const upsertConnection = (tx: Tx) =>
    tx
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
            targetBoundPendingSnapshotQuery(tx, input.state.organizationId),
          ),
        ),
      });

  if (getDatabaseProvider() === "postgres") {
    await runPostgresTransaction(async (tx) => {
      await lockGoogleDriveArchiveConnectionForOrganization(
        tx,
        input.state.organizationId,
      );
      const [lockedConnection] = await tx
        .select({
          googleAccountId: googleDriveArchiveConnections.googleAccountId,
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
        lockedConnection &&
        lockedConnection.googleAccountId !== input.googleAccountId
      ) {
        const [pendingSnapshot] = await targetBoundPendingSnapshotQuery(
          tx,
          input.state.organizationId,
        ).limit(1);
        if (pendingSnapshot)
          throw new Error("google_drive_archive_target_change_blocked");
      }

      await upsertConnection(tx);
      const [saved] = await tx
        .select({
          googleAccountId: googleDriveArchiveConnections.googleAccountId,
        })
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
    });
    return;
  }

  await runBatch((tx) => [
    lockGoogleDriveArchiveConnectionForOrganization(
      tx,
      input.state.organizationId,
    ),
    upsertConnection(tx),
  ]);
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
