import { expect, it, vi } from "vitest";
import { createGoogleDriveProjectSettingsSnapshotArchive } from "./googleDriveSnapshotArchive";
import {
  createArchiveHarness,
  encryptedEnvelopeSchema,
  FOLDER_ID,
  requestUrl,
  snapshot,
} from "./googleDriveSnapshotArchive.test-utils";

it("stores only the encrypted envelope and verifies idempotent read-back", async () => {
  const harness = createArchiveHarness();
  const saved = snapshot();
  const fileId = await harness.archive.generateFileId(saved.projectId);

  await harness.archive.putEncryptedSnapshot(saved, fileId);
  await harness.archive.putEncryptedSnapshot(saved, fileId);

  expect(harness.storedFiles.size).toBe(1);
  const archivedFile = [...harness.storedFiles.values()][0];
  if (!archivedFile) throw new Error("Expected the snapshot to be archived.");
  const uploadedValue: unknown = JSON.parse(archivedFile.content);
  const uploaded = encryptedEnvelopeSchema.parse(uploadedValue);
  expect(uploaded).toEqual({
    algorithm: saved.algorithm,
    schemaVersion: saved.schemaVersion,
    iv: saved.iv,
    ciphertext: saved.ciphertext,
  });
  expect(JSON.stringify(uploaded)).not.toContain(saved.projectId);
  expect(JSON.stringify(uploaded)).not.toContain(saved.idempotencyKey);
  expect(
    harness.fetcher.mock.calls.filter(([input]) =>
      requestUrl(input).includes("/upload/drive/v3/files"),
    ),
  ).toHaveLength(1);
  expect(
    harness.fetcher.mock.calls.some(([input]) =>
      requestUrl(input).includes(
        "/files/generateIds?count=1&space=drive&type=files",
      ),
    ),
  ).toBe(true);
});

it("accepts a writable My Drive folder selected by Picker", async () => {
  const harness = createArchiveHarness();
  const saved = snapshot();
  const fileId = await harness.archive.generateFileId(saved.projectId);

  await expect(
    harness.archive.putEncryptedSnapshot(saved, fileId),
  ).resolves.toBeUndefined();
  expect(harness.storedFiles.size).toBe(1);
});

it("refuses folders that are trashed or no longer writable", async () => {
  for (const options of [{ folderTrashed: true }, { folderWritable: false }]) {
    const harness = createArchiveHarness(options);
    const saved = snapshot();
    await expect(
      harness.archive.generateFileId(saved.projectId),
    ).rejects.toThrow("Google Drive snapshot archive folder is not writable");
    expect(
      harness.fetcher.mock.calls.some(([input]) =>
        requestUrl(input).includes("/files/generateIds"),
      ),
    ).toBe(false);
  }
});

it("does not confirm a remote file whose ciphertext no longer matches", async () => {
  const harness = createArchiveHarness();
  const saved = snapshot();
  const fileId = await harness.archive.generateFileId(saved.projectId);
  await harness.archive.putEncryptedSnapshot(saved, fileId);
  const file = [...harness.storedFiles.values()][0];
  if (!file) throw new Error("Expected the snapshot to be archived.");
  file.content = JSON.stringify({ ciphertext: "corrupted" });

  await expect(
    harness.archive.putEncryptedSnapshot(saved, fileId),
  ).rejects.toThrow("read-back integrity check failed");
  expect(
    harness.fetcher.mock.calls.filter(([input]) =>
      requestUrl(input).includes("/upload/drive/v3/files"),
    ),
  ).toHaveLength(1);
});

it("deduplicates concurrent uploads using the outbox-reserved file ID", async () => {
  const harness = createArchiveHarness({ concurrentLookups: true });
  const saved = snapshot();
  const fileId = await harness.archive.generateFileId(saved.projectId);

  await Promise.all([
    harness.archive.putEncryptedSnapshot(saved, fileId),
    harness.archive.putEncryptedSnapshot(saved, fileId),
  ]);

  expect(harness.storedFiles.size).toBe(1);
  expect(harness.storedFiles.has(fileId)).toBe(true);
  expect(
    harness.fetcher.mock.calls.filter(([input]) =>
      requestUrl(input).includes("/upload/drive/v3/files"),
    ),
  ).toHaveLength(2);
  expect(
    harness.fetcher.mock.calls.some(([input]) => {
      const url = new URL(requestUrl(input));
      return (
        url.pathname === `/drive/v3/files/${fileId}` &&
        url.searchParams.get("supportsAllDrives") === "true"
      );
    }),
  ).toBe(true);
});

it("does not confirm a retry after the file leaves the selected folder", async () => {
  const harness = createArchiveHarness();
  const saved = snapshot();
  const fileId = await harness.archive.generateFileId(saved.projectId);
  await harness.archive.putEncryptedSnapshot(saved, fileId);
  const archivedFile = harness.storedFiles.get(fileId);
  if (!archivedFile) throw new Error("Expected the snapshot to be archived.");
  archivedFile.parents = ["different-folder-456"];

  await expect(
    harness.archive.putEncryptedSnapshot(saved, fileId),
  ).rejects.toThrow("not in the configured archive folder");
});

it("does not confirm a retry after the file is moved to trash", async () => {
  const harness = createArchiveHarness();
  const saved = snapshot();
  const fileId = await harness.archive.generateFileId(saved.projectId);
  await harness.archive.putEncryptedSnapshot(saved, fileId);
  const archivedFile = harness.storedFiles.get(fileId);
  if (!archivedFile) throw new Error("Expected the snapshot to be archived.");
  archivedFile.trashed = true;

  await expect(
    harness.archive.putEncryptedSnapshot(saved, fileId),
  ).rejects.toThrow("snapshot file is in the trash");
});

it("rejects invalid selected folder IDs before network access", async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  const archive = createGoogleDriveProjectSettingsSnapshotArchive({
    resolveAccess: async () => ({
      folderId: "folder/another-user",
      accessToken: "synthetic-access-token",
    }),
    fetcher,
  });

  await expect(archive.generateFileId("synthetic-project-1")).rejects.toThrow(
    "archive folder is invalid",
  );
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps Google error response bodies out of surfaced archive errors", async () => {
  const providerBody = JSON.stringify({
    error: "unauthorized",
    access_token: "synthetic-sensitive-token",
  });
  const fetcher = vi.fn(
    async () => new Response(providerBody, { status: 403 }),
  );
  const archive = createGoogleDriveProjectSettingsSnapshotArchive({
    resolveAccess: async () => ({
      folderId: FOLDER_ID,
      accessToken: "synthetic-sensitive-token",
    }),
    fetcher,
  });

  await expect(archive.generateFileId("synthetic-project-1")).rejects.toThrow(
    "Google Drive archive request failed (HTTP 403).",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
