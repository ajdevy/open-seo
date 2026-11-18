import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getArchive: vi.fn(),
  deliverPending: vi.fn(),
}));

vi.mock("./googleDriveSnapshotArchive", () => ({
  getConfiguredGoogleDriveProjectSettingsSnapshotArchive: mocks.getArchive,
}));

vi.mock("./snapshotDelivery", () => ({
  deliverPendingProjectSettingsSnapshots: mocks.deliverPending,
}));

import { deliverPendingProjectSettingsSnapshotsFromCron } from "./snapshotDeliveryCron";

describe("project settings snapshot delivery cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getArchive.mockResolvedValue(null);
    mocks.deliverPending.mockResolvedValue({
      attempted: 0,
      confirmed: 0,
      unconfirmed: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips delivery when the archive is not configured", async () => {
    await deliverPendingProjectSettingsSnapshotsFromCron();

    expect(mocks.getArchive).toHaveBeenCalledOnce();
    expect(mocks.deliverPending).not.toHaveBeenCalled();
  });

  it("uses the configured archive and reports remaining unconfirmed snapshots", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const archive = { putEncryptedSnapshot: vi.fn() };
    mocks.getArchive.mockResolvedValue(archive);
    mocks.deliverPending.mockResolvedValue({
      attempted: 2,
      confirmed: 1,
      unconfirmed: 1,
    });

    await deliverPendingProjectSettingsSnapshotsFromCron();

    expect(mocks.deliverPending).toHaveBeenCalledExactlyOnceWith(archive);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[cron] Project settings snapshots remain unconfirmed",
      { attempted: 2, confirmed: 1, unconfirmed: 1 },
    );
  });

  it("logs a configured archive failure without crashing the cron batch", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = new Error("Google Drive archive folder is invalid.");
    mocks.getArchive.mockRejectedValue(failure);

    await expect(
      deliverPendingProjectSettingsSnapshotsFromCron(),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "[cron] Project settings snapshot delivery failed",
      { reason: "snapshot_delivery_failed" },
    );
    expect(mocks.deliverPending).not.toHaveBeenCalled();
  });
});
