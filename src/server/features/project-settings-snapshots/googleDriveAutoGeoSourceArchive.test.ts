import { describe, expect, it } from "vitest";
import {
  deliverEncryptedAutoGeoSourceArchive,
  prepareEncryptedAutoGeoSourceArchive,
} from "@/server/standalone/autogeo-source-archive";
import { AUTOGEO_SOURCE_CONTRACT_REVISION } from "@/server/standalone/autogeo-source-contract";
import { syntheticSourceArtifacts } from "@/server/standalone/autogeo-source-migration.test-fixtures";
import { createGoogleDriveAutoGeoSourceArchivePort } from "./googleDriveAutoGeoSourceArchive";
import { readLimitedResponseBody } from "./googleDriveAutoGeoSourceArchiveShared";

const target = {
  connectionId: "connection-12345",
  organizationId: "organization-12345",
  googleAccountId: "google-account-12345",
  folderId: "picker-folder-12345",
};
const generatedId = "generated-drive-file-12345";
const googleFolderMimeType = "application/vnd.google-apps.folder";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("synthetic Drive value is invalid");
  const entries: [string, unknown][] = Object.entries(value).map(
    ([key, entry]) => [key, entry],
  );
  return Object.fromEntries(entries);
}

function archiveDrive(options?: {
  loseFirstWriteAck?: boolean;
  corruptReadback?: boolean;
}) {
  const files = new Map<
    string,
    { metadata: Record<string, unknown>; payload: string }
  >();
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  let loseFirstWriteAck = options?.loseFirstWriteAck ?? false;

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const url = new URL(requestUrl);
    requests.push({ url, init });
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname.endsWith("/files/generateIds"))
      return jsonResponse({ ids: [generatedId] });
    if (method === "GET" && url.pathname.endsWith(`/${target.folderId}`))
      return jsonResponse({
        id: target.folderId,
        mimeType: googleFolderMimeType,
        trashed: false,
        capabilities: { canAddChildren: true },
      });
    if (method === "GET" && url.pathname.endsWith("/files")) {
      const query = url.searchParams.get("q") ?? "";
      const matches = [...files.values()]
        .map((file) => file.metadata)
        .filter((metadata) =>
          query.includes(
            String(record(metadata.appProperties).openSeoSourceIdempotencyHash),
          ),
        );
      return jsonResponse({ files: matches, incompleteSearch: false });
    }
    if (method === "POST" && url.pathname.endsWith("/files")) {
      const body = init?.body;
      if (typeof body !== "string")
        throw new Error("synthetic Drive multipart body is invalid");
      const boundary = /boundary=([^;]+)/u.exec(
        new Headers(init?.headers).get("content-type") ?? "",
      )?.[1];
      if (!boundary) throw new Error("multipart boundary missing");
      const partHeader =
        "Content-Type: application/json; charset=UTF-8\r\n\r\n";
      const metadataStart = body.indexOf(partHeader) + partHeader.length;
      const metadataEnd = body.indexOf(`\r\n--${boundary}`, metadataStart);
      const payloadHeaderStart = body.indexOf(partHeader, metadataEnd);
      const payloadStart = payloadHeaderStart + partHeader.length;
      const payloadEnd = body.indexOf(`\r\n--${boundary}--`, payloadStart);
      const metadata = record(
        JSON.parse(body.slice(metadataStart, metadataEnd)),
      );
      const payload = body.slice(payloadStart, payloadEnd);
      const id = String(metadata.id);
      const saved = { metadata: { ...metadata, trashed: false }, payload };
      files.set(id, saved);
      if (loseFirstWriteAck) {
        loseFirstWriteAck = false;
        throw new Error("synthetic lost upload acknowledgement");
      }
      return jsonResponse(saved.metadata);
    }
    if (method === "GET" && url.pathname.includes("/files/")) {
      const fileId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const saved = files.get(fileId);
      if (!saved) return jsonResponse({ error: "not found" }, 404);
      if (url.searchParams.get("alt") === "media")
        return new Response(
          options?.corruptReadback ? `${saved.payload} ` : saved.payload,
          { status: 200 },
        );
      return jsonResponse(saved.metadata);
    }
    throw new Error(`unexpected synthetic Drive request: ${method} ${url}`);
  };

  return { fetcher, files, requests };
}

async function encryptedEnvelope() {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const envelope = await prepareEncryptedAutoGeoSourceArchive(
    {
      clientRef: "synthetic-autogeo-client",
      sourceContractRevision: AUTOGEO_SOURCE_CONTRACT_REVISION,
      idempotencyKey: "synthetic-idempotency-key",
      artifacts: syntheticSourceArtifacts(),
    },
    key,
  );
  return { key, envelope };
}

describe("Google Drive AutoGeo source archive adapter", () => {
  it("bounds Drive read-back streams even when content length is absent", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(3));
          controller.enqueue(new Uint8Array(3));
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    await expect(readLimitedResponseBody(response, 4)).rejects.toThrow(
      "Google Drive source archive response exceeds its limit",
    );
    expect(canceled).toBe(true);
  });

  it("uploads only the encrypted envelope to the selected Picker folder and verifies read-back", async () => {
    const drive = archiveDrive();
    const port = createGoogleDriveAutoGeoSourceArchivePort({
      fetcher: drive.fetcher,
      async resolveAccess(organizationId) {
        if (organizationId !== target.organizationId)
          throw new Error("unexpected organization");
        return {
          target,
          folderId: target.folderId,
          accessToken: "synthetic-access-token",
        };
      },
    });
    const { key, envelope } = await encryptedEnvelope();
    const reservation = await port.generateFileId(target.organizationId);

    const result = await deliverEncryptedAutoGeoSourceArchive(
      envelope,
      key,
      port,
      reservation,
    );

    expect(result).toMatchObject({
      status: "confirmed",
      fileId: generatedId,
      artifactCount: 2,
    });
    expect(drive.files.size).toBe(1);
    const stored = drive.files.get(generatedId);
    expect(stored?.metadata.parents).toEqual([target.folderId]);
    expect(stored?.payload).not.toContain("Synthetic prior answer");
    expect(stored?.payload).not.toContain("prompts/");
    expect(
      drive.requests.every(
        ({ init }) =>
          new Headers(init?.headers).get("authorization") ===
          "Bearer synthetic-access-token",
      ),
    ).toBe(true);
  });

  it("retries a lost upload acknowledgement using the same reserved ID", async () => {
    const drive = archiveDrive({ loseFirstWriteAck: true });
    const port = createGoogleDriveAutoGeoSourceArchivePort({
      fetcher: drive.fetcher,
      async resolveAccess() {
        return {
          target,
          folderId: target.folderId,
          accessToken: "synthetic-access-token",
        };
      },
    });
    const { key, envelope } = await encryptedEnvelope();
    const reservation = await port.generateFileId(target.organizationId);

    await expect(
      deliverEncryptedAutoGeoSourceArchive(envelope, key, port, reservation),
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "write_unconfirmed",
    });
    await expect(
      deliverEncryptedAutoGeoSourceArchive(envelope, key, port, reservation),
    ).resolves.toMatchObject({ status: "confirmed", fileId: generatedId });
    expect(drive.files.size).toBe(1);
  });

  it("fails closed if the selected connection or folder changed after reservation", async () => {
    const drive = archiveDrive();
    const port = createGoogleDriveAutoGeoSourceArchivePort({
      fetcher: drive.fetcher,
      async resolveAccess() {
        return {
          target: { ...target, folderId: "different-picker-folder" },
          folderId: "different-picker-folder",
          accessToken: "synthetic-access-token",
        };
      },
    });
    const { key, envelope } = await encryptedEnvelope();

    await expect(
      deliverEncryptedAutoGeoSourceArchive(envelope, key, port, {
        fileId: generatedId,
        target,
      }),
    ).resolves.toMatchObject({
      status: "unconfirmed",
      reason: "write_unconfirmed",
    });
    expect(drive.files.size).toBe(0);
    expect(drive.requests).toHaveLength(0);
  });
});
