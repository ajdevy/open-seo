import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectSettingsSnapshotNotice } from "./ProjectSettingsSnapshotNotice";

describe("project settings snapshot notice", () => {
  it("clearly marks an unconfirmed snapshot as not yet recoverable", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectSettingsSnapshotNotice, {
        snapshot: {
          revision: 3,
          status: "unconfirmed",
          recoverableAfterServerLoss: false,
        },
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("Settings snapshot pending archive confirmation");
    expect(html).toContain("not recoverable after server loss");
  });

  it("shows recovery only after remote confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectSettingsSnapshotNotice, {
        snapshot: {
          revision: 3,
          status: "confirmed",
          recoverableAfterServerLoss: true,
        },
      }),
    );

    expect(html).toContain("confirmed in the remote archive");
    expect(html).toContain("recoverable after server loss");
  });

  it("renders no snapshot as not recoverable", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectSettingsSnapshotNotice, {
        snapshot: {
          revision: null,
          status: "unavailable",
          recoverableAfterServerLoss: false,
        },
      }),
    );

    expect(html).toContain("No settings snapshot archived");
    expect(html).toContain("current settings are not recoverable");
  });
});
