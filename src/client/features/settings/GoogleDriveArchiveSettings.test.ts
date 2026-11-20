import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoogleDriveArchiveSettings } from "./GoogleDriveArchiveSettings";

function renderArchiveSettings(unconfirmedSnapshots: number) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["googleDriveArchiveStatus"], {
    configured: true,
    connected: true,
    unconfirmedSnapshots,
    status: "connected",
    accountEmail: "owner@example.com",
    folder: { id: "archive-folder", name: "Settings archive" },
    pickerReady: false,
  });

  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(GoogleDriveArchiveSettings),
    ),
  );
}

describe("GoogleDriveArchiveSettings", () => {
  it("does not show a pending notice when every snapshot is confirmed", () => {
    const markup = renderArchiveSettings(0);

    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("waiting for Drive confirmation");
  });

  it.each([
    [1, "1 project settings snapshot is waiting for Drive confirmation."],
    [2, "2 project settings snapshots are waiting for Drive confirmation."],
  ])("clearly marks %i unconfirmed snapshot(s) as pending", (count, copy) => {
    const markup = renderArchiveSettings(count);

    expect(markup).toContain('role="status"');
    expect(markup).toContain(copy);
    expect(markup).toContain(
      "Only confirmed snapshots can be restored after server loss.",
    );
  });
});
