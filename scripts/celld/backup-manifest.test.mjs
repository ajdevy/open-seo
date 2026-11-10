import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateBackupManifest } from "./backup-manifest.mjs";

const digest = (value) => value.repeat(64);
const backup = () => ({
  format: 1,
  celld: "0.5.1",
  image: `sha256:${digest("a")}`,
  files: {
    "storage.tar.gz": digest("b"),
    "config.tar.gz": digest("c"),
  },
});

describe("standalone backup compatibility", () => {
  it("accepts a complete manifest for the exact fixed image digest", () => {
    const manifest = backup();
    assert.doesNotThrow(() => validateBackupManifest(manifest, manifest.image));
  });

  it("rejects a different image even when the product version tag matches", () => {
    assert.throws(
      () => validateBackupManifest(backup(), `sha256:${digest("d")}`),
      /does not match the backup image digest/,
    );
  });

  it("rejects missing checksums and unsupported backup formats", () => {
    const missingChecksum = backup();
    delete missingChecksum.files["config.tar.gz"];
    assert.throws(
      () => validateBackupManifest(missingChecksum),
      /checksums are invalid/,
    );

    const unsupported = backup();
    unsupported.format = 2;
    assert.throws(
      () => validateBackupManifest(unsupported),
      /Unsupported or invalid/,
    );
  });
});
