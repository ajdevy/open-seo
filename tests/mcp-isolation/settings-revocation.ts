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
    const response = await page.goto("/settings");
    expect(response?.status()).toBe(200);
    expect(await response?.text()).toContain('aria-label="Loading"');

    await step("Settings -> Connected agents -> Disconnect", async () => {
      await expect(
        page.getByRole("heading", { name: "Settings", exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("heading", { name: "Connected agents", exact: true }),
      ).toBeVisible({ timeout: 60_000 });
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
