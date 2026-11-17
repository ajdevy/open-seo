import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiObservations, aiProviderRunReservations, aiRuns } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { runCheck } from "./aiVisibilityRuns";
import { estimateCost } from "./aiVisibilityCost";
import { getTracker } from "./aiVisibilityState";
import { configuration, customer } from "./aiVisibilityTestFixtures";
import { sendCreditsExhaustedEvent } from "@/server/email/onboarding-drip";

const { testDb, workflow, hosted, credits } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    workflow: { create: vi.fn(), get: vi.fn() },
    hosted: vi.fn(),
    credits: vi.fn(),
  };
});
vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1", AI_VISIBILITY_WORKFLOW: workflow },
}));
vi.mock("@/db", () => ({ db: testDb.db }));
vi.mock("@/db/runBatch", () => ({ runBatch: testDb.runBatch }));
vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: async () => "dataforseo-key",
  isHostedServerAuthMode: hosted,
}));
vi.mock("@/server/billing/subscription", () => ({
  getOrCreateOrganizationCustomer: async () => ({ id: "organization" }),
  getUsageCreditsRemaining: credits,
}));
vi.mock("@/server/email/onboarding-drip", () => ({
  sendCreditsExhaustedEvent: vi.fn(),
}));

const projectId = "project";
const workflowStatus = (status: string) =>
  workflow.get.mockResolvedValue({ status: async () => ({ status }) });

beforeEach(async () => {
  await testDb.seedProject();
  await repo.saveConfiguration(
    configuration({
      engines: ["chatgpt"],
      prompts: [{ text: "Which SEO tools?" }, { text: "Is OpenSEO good?" }],
    }),
  );
  workflowStatus("running");
  hosted.mockResolvedValue(false);
  credits.mockResolvedValue({ monthlyRemaining: 0, topupRemaining: 0 });
});

describe("AI visibility checks", () => {
  it("runs one check at a time and points a second start at the running one", async () => {
    const run = await runCheck({ projectId, maxCostUsd: 1 }, customer);
    expect(run).toMatchObject({ status: "queued", expected: 2, pending: 2 });
    expect(workflow.create).toHaveBeenCalledWith({
      id: run.id,
      params: { runId: run.id, customer: { ...customer, projectId } },
    });
    await expect(
      runCheck({ projectId, maxCostUsd: 1 }, customer),
    ).rejects.toMatchObject({ reason: "RUN_IN_PROGRESS", runId: run.id });
    expect(workflow.create).toHaveBeenCalledOnce();
  });

  it("fails a check whose workflow stopped, so it never blocks the next one", async () => {
    const stuck = await runCheck({ projectId, maxCostUsd: 1 }, customer);
    await testDb.db
      .update(aiRuns)
      .set({ status: "running", createdAt: "2026-01-01T00:00:00.000Z" });
    workflowStatus("errored");

    const next = await runCheck({ projectId, maxCostUsd: 1 }, customer);

    expect(next.id).not.toBe(stuck.id);
    expect(await repo.getRunInternal(stuck.id)).toMatchObject({
      status: "failed",
    });
    expect(
      await testDb.db
        .selectDistinct({ status: aiObservations.status })
        .from(aiObservations)
        .where(eq(aiObservations.runId, stuck.id)),
    ).toEqual([{ status: "failed" }]);
  });

  it("terminates a check whose workflow is still running after 12 hours, so it stops blocking", async () => {
    const stuck = await runCheck({ projectId, maxCostUsd: 1 }, customer);
    await testDb.db
      .update(aiRuns)
      .set({ status: "running", createdAt: "2026-01-01T00:00:00.000Z" });
    const terminate = vi.fn();
    workflow.get.mockResolvedValue({
      status: async () => ({ status: "running" }),
      terminate,
    });

    const next = await runCheck({ projectId, maxCostUsd: 1 }, customer);

    expect(next.id).not.toBe(stuck.id);
    expect(terminate).toHaveBeenCalled();
    expect(await repo.getRunInternal(stuck.id)).toMatchObject({
      status: "failed",
    });
  });

  it("marks only prompts with collected answer text as having results", async () => {
    const run = await runCheck({ projectId, maxCostUsd: 1 }, customer);
    const answers = await repo.getObservations([run.id]);
    for (const answer of answers)
      await testDb.db
        .update(aiObservations)
        .set({
          status: "completed",
          // A completed collection without text means no answer was shown.
          answerMarkdown:
            answer.prompt === "Is OpenSEO good?" ? "OpenSEO is good." : null,
        })
        .where(eq(aiObservations.id, answer.id));

    const { prompts } = await getTracker({ projectId });

    expect(
      Object.fromEntries(
        prompts.map((prompt) => [prompt.text, prompt.hasResults]),
      ),
    ).toEqual({ "Is OpenSEO good?": true, "Which SEO tools?": false });
  });

  it("refuses a check that now costs more than the approved maximum", async () => {
    await expect(
      runCheck({ projectId, maxCostUsd: 0.001 }, customer),
    ).rejects.toMatchObject({ reason: "COST_LIMIT_EXCEEDED" });
    expect(await repo.listRuns(projectId)).toEqual([]);
  });

  it("refuses a provider run above the saved rolling budget before workflow start", async () => {
    const tracker = await repo.getTracker(projectId);
    if (!tracker) throw new Error("Tracker fixture was not saved.");
    await repo.updateTracker(tracker.id, { weeklyProviderBudgetCents: 1 });

    await expect(
      runCheck({ projectId, maxCostUsd: 1 }, customer),
    ).rejects.toMatchObject({ reason: "PROVIDER_BUDGET_EXCEEDED" });

    expect(workflow.create).not.toHaveBeenCalled();
    expect(await repo.listRuns(projectId)).toMatchObject([
      { status: "failed" },
    ]);
    expect(await testDb.db.select().from(aiProviderRunReservations)).toEqual(
      [],
    );
    expect((await repo.getTracker(projectId))?.lastSkipReason).toContain(
      "rolling 7-day budget",
    );
  });

  it("includes an admitted run hold in the customer-facing budget estimate", async () => {
    await runCheck({ projectId, maxCostUsd: 1 }, customer);

    const estimate = await estimateCost({ projectId });

    expect(estimate).toMatchObject({
      weeklyProviderBudgetUsd: 8,
      weeklyProviderBudgetAccountedUsd: 0,
      weeklyProviderBudgetHeldUsd: 0.024,
      weeklyProviderBudgetAvailableUsd: 7.976,
      runNowProviderBudgetRemainingUsd: 7.952,
      weeklyProviderBudgetScope: "installation",
      weeklyProviderBudgetWindowDays: 7,
    });
  });

  it("shows installation-wide reservations from other projects in the estimate", async () => {
    const secondProjectId = "second-project";
    await testDb.client.execute(`
      INSERT INTO projects (id, organization_id, name, domain)
      VALUES ('second-project', 'organization', 'Second project', 'second.example');
    `);
    const secondConfiguration = configuration(
      { engines: ["claude"], prompts: [{ text: "Which SEO tools?" }] },
      secondProjectId,
    );
    await repo.saveConfiguration(secondConfiguration);
    const createdAt = new Date().toISOString();
    await testDb.db.insert(aiRuns).values({
      id: "second-project-run",
      trackerId: secondConfiguration.tracker.id,
      projectId: secondProjectId,
      trigger: "manual",
      status: "completed",
      locationCode: 2840,
      languageCode: "en",
      createdAt,
      completedAt: createdAt,
    });
    await testDb.db.insert(aiProviderRunReservations).values({
      id: "second-project-reservation",
      projectId: secondProjectId,
      runId: "second-project-run",
      reservedUsdMicros: 7_990_000,
      status: "unknown",
      createdAt,
    });

    const estimate = await estimateCost({ projectId });

    expect(estimate).toMatchObject({
      weeklyProviderBudgetUsd: 8,
      weeklyProviderBudgetAccountedUsd: 0,
      weeklyProviderBudgetHeldUsd: 7.99,
      weeklyProviderBudgetAvailableUsd: 0.01,
      weeklyProviderBudgetGlobalAvailableUsd: 0.01,
      weeklyProviderBudgetScope: "installation",
      weeklyProjectProviderBudgetUsd: 8,
      weeklyProjectProviderBudgetAvailableUsd: 8,
      weeklyProviderBudgetWindowDays: 7,
    });

    const refusedCheck = runCheck({ projectId, maxCostUsd: 1 }, customer);
    await expect(refusedCheck).rejects.toHaveProperty(
      "reason",
      "PROVIDER_BUDGET_EXCEEDED",
    );
    await expect(refusedCheck).rejects.toThrow("installation-wide");
    expect(workflow.create).not.toHaveBeenCalled();
  });

  it("refuses a check the credits cannot cover before it starts, and says why on the tracker", async () => {
    hosted.mockResolvedValue(true);

    await expect(
      runCheck({ projectId, maxCostUsd: 1 }, customer),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });

    expect(await repo.listRuns(projectId)).toEqual([]);
    expect(workflow.create).not.toHaveBeenCalled();
    expect((await repo.getTracker(projectId))?.lastSkipReason).toBe(
      "INSUFFICIENT_CREDITS",
    );
    expect(sendCreditsExhaustedEvent).toHaveBeenCalledWith(customer);
  });

  it("starts a check that top-up credits cover after research overdrew monthly credits", async () => {
    hosted.mockResolvedValue(true);
    credits.mockResolvedValue({
      monthlyRemaining: -1000,
      topupRemaining: 1000,
    });

    const run = await runCheck({ projectId, maxCostUsd: 1 }, customer);

    expect(run.status).toBe("queued");
  });
});
