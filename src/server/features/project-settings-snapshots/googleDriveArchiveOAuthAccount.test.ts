import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ verification: {} }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => undefined,
}));

import { getGoogleDriveAccountIdentity } from "./googleDriveArchiveOAuthAccount";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses Drive permissionId and permits an unavailable email address", async () => {
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        user: { permissionId: "drive-permission-1", me: true },
      }),
  );
  vi.stubGlobal("fetch", fetcher);

  await expect(
    getGoogleDriveAccountIdentity("synthetic-access-token"),
  ).resolves.toEqual({
    googleAccountId: "drive-permission-1",
    accountEmail: null,
  });
  const call = fetcher.mock.calls[0];
  if (!call) throw new Error("Drive About request was not made.");
  const [input, init] = call;
  if (!(input instanceof URL))
    throw new Error("Drive About request URL was not normalized.");
  expect(input.href).toBe(
    "https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%2CemailAddress%2Cme%29",
  );
  expect(init).toMatchObject({
    headers: { Authorization: "Bearer synthetic-access-token" },
  });
});

it("returns the optional Drive email address when Google provides it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        user: {
          permissionId: "drive-permission-1",
          emailAddress: "owner@example.com",
          me: true,
        },
      }),
    ),
  );

  await expect(
    getGoogleDriveAccountIdentity("synthetic-access-token"),
  ).resolves.toEqual({
    googleAccountId: "drive-permission-1",
    accountEmail: "owner@example.com",
  });
});

it.each([
  {
    name: "a different Google user",
    user: { permissionId: "id-1", me: false },
  },
  { name: "a missing permission ID", user: { me: true } },
])("rejects Drive identity when it is $name", async ({ user }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ user })),
  );

  await expect(
    getGoogleDriveAccountIdentity("synthetic-access-token"),
  ).rejects.toThrow();
});
