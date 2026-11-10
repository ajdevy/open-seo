const files = ["storage.tar.gz", "config.tar.gz"];
const digestPattern = /^[a-f0-9]{64}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;

export function validateBackupManifest(manifest, imageId) {
  if (
    !manifest ||
    manifest.format !== 1 ||
    manifest.celld !== "0.5.1" ||
    !imagePattern.test(manifest.image ?? "")
  )
    throw new Error("Unsupported or invalid backup manifest");
  if (
    !manifest.files ||
    Object.keys(manifest.files).length !== files.length ||
    files.some((file) => !digestPattern.test(manifest.files[file] ?? ""))
  )
    throw new Error("Backup manifest checksums are invalid");
  if (imageId !== undefined && manifest.image !== imageId)
    throw new Error("Restore image does not match the backup image digest");
}
