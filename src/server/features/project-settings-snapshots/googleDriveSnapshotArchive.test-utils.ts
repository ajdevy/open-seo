import { expect, vi } from "vitest";
import { z } from "zod";
import { createGoogleDriveProjectSettingsSnapshotArchive } from "./googleDriveSnapshotArchive";
import type { EncryptedProjectSettingsSnapshot } from "./snapshotDelivery";

export const FOLDER_ID = "picked-folder-123";

export const encryptedEnvelopeSchema = z.object({
  algorithm: z.string(),
  schemaVersion: z.number(),
  iv: z.string(),
  ciphertext: z.string(),
});

export function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

export function snapshot(): EncryptedProjectSettingsSnapshot {
  return {
    projectId: "synthetic-project-1",
    revision: 3,
    idempotencyKey: "open-seo:project-settings:synthetic-project-1:3",
    algorithm: "AES-GCM-256",
    schemaVersion: 1,
    iv: "synthetic-iv",
    ciphertext: "synthetic-ciphertext",
  };
}

export function createArchiveHarness(
  options: {
    folderWritable?: boolean;
    folderTrashed?: boolean;
    concurrentLookups?: boolean;
  } = {},
) {
  let lookupCount = 0;
  let releaseLookups: (() => void) | undefined;
  const bothLookups = new Promise<void>((resolve) => {
    releaseLookups = resolve;
  });
  const storedFiles = new Map<
    string,
    {
      appProperties: Record<string, string>;
      content: string;
      parents: string[];
      trashed: boolean;
    }
  >();
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      const method = init?.method ?? "GET";
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe("Bearer synthetic-access-token");

      if (url.pathname === `/drive/v3/files/${FOLDER_ID}`) {
        return Response.json({
          id: FOLDER_ID,
          mimeType: "application/vnd.google-apps.folder",
          trashed: options.folderTrashed ?? false,
          capabilities: { canAddChildren: options.folderWritable ?? true },
        });
      }
      if (url.pathname === "/drive/v3/files/generateIds")
        return Response.json({ ids: ["generated-drive-file-123"] });
      if (url.pathname === "/drive/v3/files" && method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        const hash = query.match(/value='([a-f0-9]{64})'/u)?.[1];
        const files = [...storedFiles.entries()]
          .filter(
            ([, file]) =>
              !file.trashed &&
              file.parents.includes(FOLDER_ID) &&
              file.appProperties.openSeoIdempotencyHash === hash,
          )
          .map(([id, file]) => ({
            id,
            appProperties: file.appProperties,
            parents: file.parents,
            trashed: file.trashed,
          }));
        if (options.concurrentLookups) {
          lookupCount++;
          if (lookupCount === 2) releaseLookups?.();
          await bothLookups;
        }
        return Response.json({ files, incompleteSearch: false });
      }
      if (url.pathname.startsWith("/drive/v3/files/")) {
        const fileId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const file = storedFiles.get(fileId);
        if (url.searchParams.get("alt") === "media" && file)
          return new Response(file.content);
        return file
          ? Response.json({
              id: fileId,
              appProperties: file.appProperties,
              parents: file.parents,
              trashed: file.trashed,
            })
          : new Response(null, { status: 404 });
      }
      if (url.pathname === "/upload/drive/v3/files") {
        const contentType =
          new Headers(init?.headers).get("content-type") ?? "";
        const boundary = contentType.match(/boundary=([^;]+)/u)?.[1];
        if (!boundary) return new Response(null, { status: 400 });
        if (typeof init?.body !== "string")
          return new Response(null, { status: 400 });
        const parts = init.body.split(`--${boundary}`);
        const metadataPart = parts[1]?.split("\r\n\r\n")[1]?.split("\r\n")[0];
        const payloadPart = parts[2]?.split("\r\n\r\n")[1]?.split("\r\n")[0];
        if (!metadataPart || !payloadPart)
          return new Response(null, { status: 400 });
        const metadataValue: unknown = JSON.parse(metadataPart);
        const metadata = z
          .object({
            id: z.string(),
            appProperties: z.record(z.string(), z.string()),
            parents: z.array(z.string()),
          })
          .parse(metadataValue);
        expect(metadata.parents).toEqual([FOLDER_ID]);
        if (storedFiles.has(metadata.id))
          return new Response(null, { status: 409 });
        storedFiles.set(metadata.id, {
          appProperties: metadata.appProperties,
          content: payloadPart,
          parents: metadata.parents,
          trashed: false,
        });
        return Response.json({
          id: metadata.id,
          appProperties: metadata.appProperties,
          parents: metadata.parents,
          trashed: false,
        });
      }
      return new Response(null, { status: 404 });
    },
  );
  return {
    storedFiles,
    fetcher,
    archive: createGoogleDriveProjectSettingsSnapshotArchive({
      resolveAccess: async () => ({
        folderId: FOLDER_ID,
        accessToken: "synthetic-access-token",
      }),
      fetcher,
    }),
  };
}
