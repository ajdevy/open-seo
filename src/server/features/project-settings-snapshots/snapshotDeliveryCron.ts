import { getConfiguredGoogleDriveProjectSettingsSnapshotArchive } from "./googleDriveSnapshotArchive";
import { deliverPendingProjectSettingsSnapshots } from "./snapshotDelivery";

/** Retry configured encrypted snapshots from the worker's scheduled handler. */
export async function deliverPendingProjectSettingsSnapshotsFromCron() {
  try {
    const archive =
      await getConfiguredGoogleDriveProjectSettingsSnapshotArchive();
    if (!archive) return;

    const result = await deliverPendingProjectSettingsSnapshots(archive);
    if (result.unconfirmed > 0)
      console.warn(
        "[cron] Project settings snapshots remain unconfirmed",
        result,
      );
  } catch {
    console.error("[cron] Project settings snapshot delivery failed", {
      reason: "snapshot_delivery_failed",
    });
  }
}
