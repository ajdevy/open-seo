import { describe, expect, it } from "vitest";
import everyAppConfig from "../../../../everyapp.config";

describe("Every App snapshot encryption configuration", () => {
  it("requires the key before the app accepts settings writes", () => {
    const secret = everyAppConfig.secrets.find(
      ({ name }) => name === "AUTOGEO_QUEUE_MASTER_KEY_B64",
    );

    expect(secret).toBeDefined();
    if (!secret) return;
    expect("optional" in secret ? secret.optional : undefined).not.toBe(true);
  });
});
