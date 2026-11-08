import { expect, type APIRequestContext, type Browser } from "@playwright/test";
import { check } from "./checks";
import { callTool, describeResult } from "./mcp";
import type { Tenant } from "./tenants";

type Step = (title: string, body: () => Promise<void>) => Promise<void>;

type SettingsRevocationOptions = {
  browser: Browser;
  anon: APIRequestContext;
  tenant: Tenant;
  oauthClientName: string;
  apiKeyName: string;
  step: Step;
};

export async function revokeCredentialsInSettings({
  browser,
  anon,
  tenant,
  oauthClientName,
  apiKeyName,
  step,
}: SettingsRevocationOptions) {
  const chapter = "5 revocation";
  const readProject = {
    name: "get_project_context",
    arguments: { projectId: tenant.projectId },
  };
  const context = await browser.newContext({
    baseURL: tenant.baseURL,
    storageState: await tenant.api.storageState(),
  });
  const page = await context.newPage();
  try {
    // No onboarding redirect: OAuth consent and create_project completed it.
    const startupModules: Array<{
      atMs: number;
      path: string;
      status: number;
    }> = [];
    const startupRequests: Array<{ atMs: number; path: string }> = [];
    const browserErrors: string[] = [];
    const startedAt = Date.now();

    page.on("response", (response) => {
      const { pathname } = new URL(response.url());
      const isSettingsStartupModule =
        pathname.includes("virtual:tanstack-start-dev-client-entry") ||
        pathname.endsWith("/default-entry/client.tsx") ||
        [
          "/src/router.tsx",
          "/src/routeTree.gen.ts",
          "/src/routes/__root.tsx",
          "/src/routes/_app/route.tsx",
          "/src/routes/_app/settings.tsx",
          "/src/routes/_app/settings/index.tsx",
        ].includes(pathname);
      if (isSettingsStartupModule) {
        startupModules.push({
          atMs: Date.now() - startedAt,
          path: pathname,
          status: response.status(),
        });
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/_serverFn/")) {
        startupRequests.push({
          atMs: Date.now() - startedAt,
          path: pathname.startsWith("/_serverFn/") ? "/_serverFn" : pathname,
        });
      }
    });
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        browserErrors.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      browserErrors.push(`pageerror: ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/@id/") || pathname.startsWith("/src/")) {
        browserErrors.push(`requestfailed: ${pathname}`);
      }
    });
    await page.addInitScript(() => {
      const startup = {
        clientEntryExecutedAt: null as number | null,
        defaultEntryExecutedAt: null as number | null,
        firstReactCommit: null as Record<string, unknown> | null,
        firstSettingsCommit: null as Record<string, unknown> | null,
      };
      Object.defineProperty(window, "__settingsStartup", {
        configurable: true,
        value: startup,
      });
      const renderers = new Map<number, unknown>();
      Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
        configurable: true,
        value: {
          supportsFiber: true,
          renderers,
          inject(renderer: unknown) {
            const rendererId = renderers.size + 1;
            renderers.set(rendererId, renderer);
            return rendererId;
          },
          onCommitFiberRoot(
            _rendererId: number,
            root: { current?: { child?: unknown } },
            _priorityLevel: number,
            didError: boolean,
          ) {
            const heading = Array.from(
              document.querySelectorAll("h1, h2"),
            ).some((element) => element.textContent?.trim() === "Settings");
            const commit = {
              atMs: performance.now(),
              didError,
              hasReactChildren: Boolean(root.current?.child),
              bodyTextLength: document.body.innerText.length,
              settingsHeading: heading,
            };
            if (startup.firstReactCommit === null) {
              startup.firstReactCommit = commit;
            }
            if (heading && startup.firstSettingsCommit === null) {
              startup.firstSettingsCommit = commit;
            }
          },
          onCommitFiberUnmount() {},
        },
      });
    });
    await page.route(
      /virtual:tanstack-start-dev-client-entry/,
      async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        await route.fulfill({
          response,
          body: `window.__settingsStartup.clientEntryExecutedAt = performance.now();\n${source}`,
        });
      },
    );
    await page.route(/default-entry\/client\.tsx/, async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({
        response,
        body: `window.__settingsStartup.defaultEntryExecutedAt = performance.now();\n${source}`,
      });
    });
    const navigationStartedAt = Date.now();
    const response = await page.goto("/settings");
    const navigationDurationMs = Date.now() - navigationStartedAt;
    expect(response?.status()).toBe(200);
    const responseHtml = await response?.text();
    expect(responseHtml).toContain('aria-label="Loading"');

    await step("Settings -> Connected agents -> Disconnect", async () => {
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("heading", { name: "Connected agents", exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      const startup = await page.evaluate(() => {
        return (
          window as Window & {
            __settingsStartup?: {
              clientEntryExecutedAt: number | null;
              defaultEntryExecutedAt: number | null;
              firstReactCommit: Record<string, unknown> | null;
              firstSettingsCommit: Record<string, unknown> | null;
            };
          }
        ).__settingsStartup;
      });
      console.log(
        "settings first-render evidence",
        JSON.stringify({
          navigationDurationMs,
          serverFallback: responseHtml?.includes('aria-label="Loading"'),
          startup,
          modules: startupModules,
          appRequests: startupRequests.slice(0, 12),
          browserErrors,
        }),
      );
      await expect(
        page.getByRole("dialog", { name: "One quick setup step" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("dialog", { name: "Connect Google Search Console" }),
      ).toHaveCount(0);
      // RowActionsMenu uses `Actions for ${clientName}`; A has two grants.
      const actions = page.getByRole("button", {
        name: `Actions for ${oauthClientName}`,
        exact: true,
      });
      await actions.click();
      await page.getByRole("menuitem", { name: "Disconnect" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await expect(actions).toHaveCount(0);

      const result = await callTool(anon, tenant.oauth, readProject);
      check({
        chapter,
        credential: tenant.oauth.label,
        tool: "get_project_context (after Disconnect)",
        expectation: "HTTP 401 with invalid_token challenge",
        ok:
          result.status === 401 &&
          /invalid_token/.test(result.headers["www-authenticate"] ?? ""),
        detail: describeResult(result),
      });
    });

    await step("Settings -> API keys -> Revoke key", async () => {
      await expect(page.getByText("API keys").first()).toBeVisible();
      // The API key row action is `Actions for ${key.name}`.
      const actions = page.getByRole("button", {
        name: `Actions for ${apiKeyName}`,
        exact: true,
      });
      await actions.click();
      await page.getByRole("menuitem", { name: "Revoke key" }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Revoke key", exact: true })
        .click();
      await expect(actions).toHaveCount(0);

      const result = await callTool(anon, tenant.apiKey, readProject);
      check({
        chapter,
        credential: tenant.apiKey.label,
        tool: "get_project_context (after Revoke key)",
        expectation: "HTTP 401 invalid_api_key",
        ok: result.status === 401 && result.errorCode === "invalid_api_key",
        detail: describeResult(result),
      });
    });
  } finally {
    await context.close();
  }
}
