import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isOperatorRequest: vi.fn(() => true),
  usesBetterAuthServer: vi.fn(async () => false),
  listUnknownAiProviderRunBudgets: vi.fn(),
  reconcileAiProviderRunBudget: vi.fn(),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ member: {}, organization: {}, user: {} }));
vi.mock("@/lib/auth", () => ({ getAuth: vi.fn() }));
vi.mock("@/server/lib/runtime-env", () => ({
  usesBetterAuthServer: mocks.usesBetterAuthServer,
}));
vi.mock("@/server/standalone/operator-auth", () => ({
  isOperatorRequest: mocks.isOperatorRequest,
}));
vi.mock(
  "@/server/features/ai-visibility/repositories/AiProviderRunBudgetRepository",
  () => ({
    listUnknownAiProviderRunBudgets: mocks.listUnknownAiProviderRunBudgets,
    reconcileAiProviderRunBudget: mocks.reconcileAiProviderRunBudget,
  }),
);

import { handleOperatorRequest } from "./admin";

function operatorRequest(body: unknown) {
  return new Request("https://open-seo.example/api/standalone/admin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("standalone provider budget operator commands", () => {
  it("serves metadata-only unknown holds when Better Auth is disabled", async () => {
    mocks.isOperatorRequest.mockReturnValue(true);
    mocks.usesBetterAuthServer.mockResolvedValue(false);
    mocks.listUnknownAiProviderRunBudgets.mockResolvedValue([
      {
        runId: "run-1",
        projectId: "project-1",
        reservedUsdMicros: 8_000_000,
        createdAt: "2026-11-19T12:00:00.000Z",
      },
    ]);

    const response = await handleOperatorRequest(
      operatorRequest({
        command: "list-ai-provider-budget-unknown",
        limit: 20,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      reservations: [
        {
          runId: "run-1",
          projectId: "project-1",
          reservedUsdMicros: 8_000_000,
          createdAt: "2026-11-19T12:00:00.000Z",
        },
      ],
    });
    expect(mocks.listUnknownAiProviderRunBudgets).toHaveBeenCalledWith(20);
  });

  it("requires explicit evidence and rejects unknown command fields", async () => {
    mocks.isOperatorRequest.mockReturnValue(true);
    const response = await handleOperatorRequest(
      operatorRequest({
        command: "reconcile-ai-provider-budget",
        runId: "run-1",
        outcome: "released",
        evidenceReference: "provider-usage:no-charge-1",
        accountId: "project-user",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.reconcileAiProviderRunBudget).not.toHaveBeenCalled();
  });

  it("reconciles provider overruns from a strict operator payload", async () => {
    mocks.isOperatorRequest.mockReturnValue(true);
    mocks.reconcileAiProviderRunBudget.mockResolvedValue({
      reconciled: true,
      status: "settled",
    });
    const command = {
      command: "reconcile-ai-provider-budget",
      runId: "run-1",
      outcome: "settled",
      accountedUsdMicros: 9_250_000,
      settledAt: "2026-11-19T12:00:00.000Z",
      reconciledAt: "2026-11-19T12:01:00.000Z",
      evidenceReference: "provider-usage:invoice-1",
    };

    const response = await handleOperatorRequest(operatorRequest(command));

    expect(response.status).toBe(200);
    expect(mocks.reconcileAiProviderRunBudget).toHaveBeenCalledWith(command);
    await expect(response.json()).resolves.toEqual({
      result: { reconciled: true, status: "settled" },
    });
  });

  it("does not expose budget commands without the operator guard", async () => {
    mocks.isOperatorRequest.mockReturnValue(false);

    const response = await handleOperatorRequest(
      operatorRequest({ command: "list-ai-provider-budget-unknown" }),
    );

    expect(response.status).toBe(404);
    expect(mocks.listUnknownAiProviderRunBudgets).not.toHaveBeenCalled();
  });
});
