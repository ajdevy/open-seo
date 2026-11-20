import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { connectionString } = vi.hoisted(() => ({
  connectionString: process.env.AI_PROVIDER_RUN_BUDGET_TEST_URL ?? "",
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "postgres",
    HYPERDRIVE: { connectionString },
  },
}));

import { db, withPgClient } from "@/db";
import {
  aiProviderRunReservations,
  aiRuns,
  aiTrackers,
  organization,
  projects,
} from "@/db/schema";
import { inArray } from "drizzle-orm";
import { AiVisibilityRepository as repo } from "./AiVisibilityRepository";
import {
  getAiProviderBudgetUsage,
  reserveAiProviderRunBudget,
} from "./AiProviderRunBudgetRepository";
import { configuration } from "../services/aiVisibilityTestFixtures";

const describePostgres = connectionString ? describe : describe.skip;
const ids = {
  organization: `budget-test-org-${randomUUID()}`,
  projectA: `budget-test-project-a-${randomUUID()}`,
  projectB: `budget-test-project-b-${randomUUID()}`,
};
const now = new Date("2026-11-20T12:00:00.000Z");
let databaseValidated = false;

function assertDisposableTestDatabase(value: string) {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  const addressType = isIP(host);
  const octets = addressType === 4 ? host.split(".").map(Number) : [];
  const privateIpv4 =
    octets.length === 4 &&
    (octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  const localHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    privateIpv4;

  if (!database.startsWith("open_seo_test_"))
    throw new Error(
      "Postgres budget integration tests require a disposable open_seo_test_ database.",
    );
  if (!localHost)
    throw new Error(
      "Postgres budget integration tests only accept loopback or private IPv4 hosts.",
    );
}

describePostgres("provider budget admission on PostgreSQL", () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(connectionString);
    databaseValidated = true;
    await withPgClient(async () => {
      await db.insert(organization).values({
        id: ids.organization,
        name: "Provider budget integration test",
        slug: ids.organization,
        createdAt: now,
      });
      await db.insert(projects).values({
        id: ids.projectA,
        organizationId: ids.organization,
        name: "Provider budget integration test A",
        domain: "budget-a-test.invalid",
      });
      await db.insert(projects).values({
        id: ids.projectB,
        organizationId: ids.organization,
        name: "Provider budget integration test B",
        domain: "budget-b-test.invalid",
      });
      await repo.saveConfiguration(
        configuration(
          {
            engines: ["chatgpt"],
            prompts: [{ text: "Synthetic provider budget race" }],
          },
          ids.projectA,
        ),
      );
      await repo.saveConfiguration(
        configuration(
          {
            engines: ["chatgpt"],
            prompts: [{ text: "Synthetic provider budget race" }],
          },
          ids.projectB,
        ),
      );
      const trackerA = await repo.getTracker(ids.projectA);
      const trackerB = await repo.getTracker(ids.projectB);
      if (!trackerA || !trackerB)
        throw new Error("The test trackers were not saved.");
      await db.insert(aiRuns).values([
        {
          id: `${ids.projectA}-run`,
          trackerId: trackerA.id,
          projectId: ids.projectA,
          trigger: "manual",
          status: "completed",
          locationCode: 2840,
          languageCode: "en",
          createdAt: now.toISOString(),
          completedAt: now.toISOString(),
        },
        {
          id: `${ids.projectB}-run`,
          trackerId: trackerB.id,
          projectId: ids.projectB,
          trigger: "manual",
          status: "completed",
          locationCode: 2840,
          languageCode: "en",
          createdAt: now.toISOString(),
          completedAt: now.toISOString(),
        },
      ]);
    });
  }, 30_000);

  afterAll(async () => {
    if (!databaseValidated) return;
    assertDisposableTestDatabase(connectionString);
    await withPgClient(async () => {
      await db
        .delete(aiProviderRunReservations)
        .where(
          inArray(aiProviderRunReservations.projectId, [
            ids.projectA,
            ids.projectB,
          ]),
        );
      await db
        .delete(aiRuns)
        .where(inArray(aiRuns.projectId, [ids.projectA, ids.projectB]));
      await db
        .delete(aiTrackers)
        .where(inArray(aiTrackers.projectId, [ids.projectA, ids.projectB]));
      await db
        .delete(projects)
        .where(inArray(projects.id, [ids.projectA, ids.projectB]));
      await db
        .delete(organization)
        .where(eq(organization.id, ids.organization));
    });
  }, 30_000);

  it("admits only one concurrent reservation under the persisted rolling cap", async () => {
    const admissions = await Promise.all(
      [
        { projectId: ids.projectA, runId: `${ids.projectA}-run` },
        { projectId: ids.projectB, runId: `${ids.projectB}-run` },
      ].map(({ projectId, runId }) =>
        withPgClient(() =>
          reserveAiProviderRunBudget(
            {
              id: `reservation-${runId}`,
              projectId,
              runId,
              limitUsdCents: 800,
              reserveUsdMicros: 5_000_000,
              createdAt: now.toISOString(),
            },
            now.getTime(),
          ),
        ),
      ),
    );

    const winnerIndex = admissions.findIndex((admission) => admission.admitted);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(admissions.filter((admission) => admission.admitted)).toHaveLength(
      1,
    );
    expect(admissions.filter((admission) => !admission.admitted)).toMatchObject(
      [{ reason: "global_budget_exceeded" }],
    );
    const winningProjectId = winnerIndex === 0 ? ids.projectA : ids.projectB;
    const losingProjectId = winnerIndex === 0 ? ids.projectB : ids.projectA;
    await expect(
      withPgClient(() =>
        getAiProviderBudgetUsage(winningProjectId, now.getTime()),
      ),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 5_000_000 });
    await expect(
      withPgClient(() =>
        getAiProviderBudgetUsage(losingProjectId, now.getTime()),
      ),
    ).resolves.toEqual({ accountedUsdMicros: 0, heldUsdMicros: 0 });
  }, 30_000);
});
