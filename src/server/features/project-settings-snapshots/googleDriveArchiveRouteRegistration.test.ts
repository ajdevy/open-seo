import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { Route } from "@/routes/api/google-drive/archive/oauth/callback";

const { handleCallback } = vi.hoisted(() => ({
  handleCallback: vi.fn(),
}));

vi.mock(
  "@/server/features/project-settings-snapshots/googleDriveArchiveOAuthCallback",
  () => ({ handleGoogleDriveArchiveOAuthCallback: handleCallback }),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequestHandler(
  value: unknown,
): value is (input: { request: Request }) => Promise<Response> {
  return typeof value === "function";
}

const callbackPath = "/api/google-drive/archive/oauth/callback";
const callbackRoute = readFileSync(
  new URL(
    "../../../routes/api/google-drive/archive/oauth/callback.ts",
    import.meta.url,
  ),
  "utf8",
);
const routeTree = readFileSync(
  new URL("../../../routeTree.gen.ts", import.meta.url),
  "utf8",
);

it("registers the Google Drive archive callback as a GET route", () => {
  expect(callbackRoute).toContain(`"${callbackPath}"`);
  expect(callbackRoute).toContain(
    "handleGoogleDriveArchiveOAuthCallback(request)",
  );
  expect(routeTree).toContain(`'${callbackPath}'`);
});

it("forwards the registered GET request to the Google Drive callback handler", async () => {
  const request = new Request(
    `https://autogeo.flexsentlabs.com${callbackPath}`,
  );
  const response = new Response(null, { status: 204 });
  handleCallback.mockResolvedValue(response);

  const serverOptions: unknown = Route.options.server;
  if (!isRecord(serverOptions))
    throw new Error("The registered callback server options are missing.");
  const handlers: unknown = serverOptions["handlers"];
  if (!isRecord(handlers))
    throw new Error("The registered callback handlers are missing.");
  const candidate = handlers["GET"];
  if (!isRequestHandler(candidate))
    throw new Error("The registered callback GET handler is missing.");

  const result = await candidate({ request });

  expect(handleCallback).toHaveBeenCalledWith(request);
  expect(result).toBe(response);
});
