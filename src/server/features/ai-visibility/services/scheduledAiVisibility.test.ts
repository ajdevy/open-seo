import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projects } from "@/db/schema";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { runScheduledAiVisibility } from "./scheduledAiVisibility";
import { configuration } from "./aiVisibilityTestFixtures";

const { testDb, workflow, hosted } = await vi.hoisted(async () => {
  const { createAiVisibilityTestDb } = await import("../aiVisibilityTestDb");
  return {
    testDb: await createAiVisibilityTestDb(),
    workflow: {
      create: vi.fn(),
      get: vi.fn(async () => ({
        status: async () => ({ status: "queued" }),
      })),
    },
    hosted: vi.fn(),
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
  getUsageCreditsRemaining: async () => ({
    monthlyRemaining: 0,
    topupRemaining: 0,
  }),
}));
vi.mock("@/server/email/onboarding-drip", () => ({
  sendCreditsExhaustedEvent: vi.fn(),
}));
vi.mock("./aiVisibilityRetention", () => ({ pruneAiVisibility: vi.fn() }));

const due = "2026-09-01T06:00:00.000Z";
async function dueTracker(
  projectId: string,
  paused: boolean,
  schedule: {
    scheduleInterval?: "daily" | "weekly" | "monthly";
    nextCheckAt?: string;
    scheduleWeekday?: number | null;
    scheduleHour?: number | null;
    scheduleMinute?: number | null;
    scheduleTimeZone?: string | null;
  } = {},
) {
  const rows = configuration(
    { engines: ["chatgpt"], prompts: [{ text: "Which SEO tools?", paused }] },
    projectId,
  );
  await repo.saveConfiguration(rows);
  await repo.updateTracker(rows.tracker.id, {
    enabled: true,
    nextCheckAt: due,
    ...schedule,
  });
}

beforeEach(async () => {
  hosted.mockResolvedValue(false);
  await testDb.seedProject();
  await testDb.db.insert(projects).values({
    id: "paused-project",
    organizationId: "organization",
    name: "Paused",
    domain: "paused.example",
  });
});

afterEach(() => vi.useRealTimers());

it("moves every due tracker on, including one whose check cannot start", async () => {
  await dueTracker("paused-project", true);
  await dueTracker("project", false);

  await runScheduledAiVisibility();

  const skipped = await repo.getTracker("paused-project");
  expect(skipped?.nextCheckAt).not.toBe(due);
  expect(skipped?.lastSkipReason).toMatch(/unpause prompts/);
  expect((await repo.getTracker("project"))?.nextCheckAt).not.toBe(due);
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "queued" },
  ]);
});

it("records a skipped check for credits on the tracker without starting it", async () => {
  hosted.mockResolvedValue(true);
  await dueTracker("project", false);

  await runScheduledAiVisibility();

  expect((await repo.getTracker("project"))?.lastSkipReason).toBe(
    "INSUFFICIENT_CREDITS",
  );
  expect(await repo.listRuns("project")).toEqual([]);
});

it("keeps both the skipped DST slot and insufficient-credit notices", async () => {
  hosted.mockResolvedValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T05:31:00.000Z"));
  await dueTracker("project", false, {
    scheduleInterval: "weekly",
    nextCheckAt: "2026-10-25T05:30:00.000Z",
    scheduleWeekday: 0,
    scheduleHour: 1,
    scheduleMinute: 30,
    scheduleTimeZone: "America/New_York",
  });

  await runScheduledAiVisibility();

  expect((await repo.getTracker("project"))?.lastSkipReason).toMatch(
    /^INSUFFICIENT_CREDITS; Skipped unresolved weekly local-time occurrence\(s\): 2026-11-01\./,
  );
  expect(await repo.listRuns("project")).toEqual([]);
});

it("advances a saved weekly wall-clock slot across spring DST", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T14:01:00.000Z"));
  const observed = "2026-03-01T14:00:00.000Z";
  await dueTracker("project", false, {
    scheduleInterval: "weekly",
    nextCheckAt: observed,
    scheduleWeekday: 0,
    scheduleHour: 9,
    scheduleMinute: 0,
    scheduleTimeZone: "America/New_York",
  });

  await runScheduledAiVisibility();

  expect((await repo.getTracker("project"))?.nextCheckAt).toBe(
    "2026-03-08T13:00:00.000Z",
  );
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "queued" },
  ]);
});

it("advances a due monthly schedule after its month-end occurrence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-01T12:01:00.000Z"));
  const observed = "2026-03-31T08:00:00.000Z";
  await dueTracker("project", false, {
    scheduleInterval: "monthly",
    nextCheckAt: observed,
    scheduleWeekday: null,
    scheduleHour: 4,
    scheduleMinute: 0,
    scheduleTimeZone: "America/New_York",
  });

  await runScheduledAiVisibility();

  expect((await repo.getTracker("project"))?.nextCheckAt).toBe(
    "2026-04-30T08:00:00.000Z",
  );
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "queued" },
  ]);
});

it("runs the due occurrence and reports a skipped ambiguous next week", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T05:31:00.000Z"));
  const observed = "2026-10-25T05:30:00.000Z";
  await dueTracker("project", false, {
    scheduleInterval: "weekly",
    nextCheckAt: observed,
    scheduleWeekday: 0,
    scheduleHour: 1,
    scheduleMinute: 30,
    scheduleTimeZone: "America/New_York",
  });

  await runScheduledAiVisibility();

  const tracker = await repo.getTracker("project");
  expect(tracker?.nextCheckAt).toBe("2026-11-08T06:30:00.000Z");
  expect(tracker?.lastSkipReason).toMatch(
    /Skipped unresolved weekly local-time occurrence\(s\): 2026-11-01/,
  );
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "queued" },
  ]);
  expect(workflow.create).toHaveBeenCalledTimes(1);
});

it("runs the due occurrence and reports a skipped nonexistent spring slot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T07:31:00.000Z"));
  const observed = "2026-03-01T07:30:00.000Z";
  await dueTracker("project", false, {
    scheduleInterval: "weekly",
    nextCheckAt: observed,
    scheduleWeekday: 0,
    scheduleHour: 2,
    scheduleMinute: 30,
    scheduleTimeZone: "America/New_York",
  });

  await runScheduledAiVisibility();

  const tracker = await repo.getTracker("project");
  expect(tracker?.nextCheckAt).toBe("2026-03-15T06:30:00.000Z");
  expect(tracker?.lastSkipReason).toMatch(
    /Skipped unresolved weekly local-time occurrence\(s\): 2026-03-08/,
  );
  expect(await repo.listRuns("project")).toMatchObject([
    { trigger: "scheduled", status: "queued" },
  ]);
});

it.each([
  {
    label: "spring gap",
    dueAt: "2026-03-01T07:30:00.000Z",
    now: "2026-03-08T07:01:00.000Z",
    hour: 2,
    minute: 30,
    expectedNext: "2026-03-15T06:30:00.000Z",
    skippedDate: "2026-03-08",
  },
  {
    label: "fall fold after the repeated hour",
    dueAt: "2026-10-25T05:30:00.000Z",
    now: "2026-11-01T06:31:00.000Z",
    hour: 1,
    minute: 30,
    expectedNext: "2026-11-08T06:30:00.000Z",
    skippedDate: "2026-11-01",
  },
])(
  "reports an unresolved weekly slot when processing resumes after the $label",
  async ({ dueAt, now, hour, minute, expectedNext, skippedDate }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    await dueTracker("project", false, {
      scheduleInterval: "weekly",
      nextCheckAt: dueAt,
      scheduleWeekday: 0,
      scheduleHour: hour,
      scheduleMinute: minute,
      scheduleTimeZone: "America/New_York",
    });

    await runScheduledAiVisibility();

    const tracker = await repo.getTracker("project");
    expect(tracker?.nextCheckAt).toBe(expectedNext);
    expect(tracker?.lastSkipReason ?? "").toMatch(
      new RegExp(
        `Skipped unresolved weekly local-time occurrence\\(s\\): ${skippedDate}`,
      ),
    );
    expect(await repo.listRuns("project")).toMatchObject([
      { trigger: "scheduled", status: "queued" },
    ]);
  },
);

it("pauses an incomplete saved weekly local-time schedule instead of retrying it forever", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T14:01:00.000Z"));
  await dueTracker("project", false, {
    scheduleInterval: "weekly",
    nextCheckAt: "2026-03-01T14:00:00.000Z",
    scheduleHour: 9,
    scheduleTimeZone: "America/New_York",
  });

  await runScheduledAiVisibility();

  const tracker = await repo.getTracker("project");
  expect(tracker?.enabled).toBe(false);
  expect(tracker?.nextCheckAt).toBe("2026-03-01T14:00:00.000Z");
  expect(tracker?.lastSkipReason).toMatch(/schedule is incomplete/i);
  expect(await repo.listRuns("project")).toEqual([]);
});

it("keeps legacy trackers on the fixed UTC-anchor recurrence", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T14:01:00.000Z"));
  await dueTracker("project", false, {
    scheduleInterval: "weekly",
    nextCheckAt: "2026-03-01T14:00:00.000Z",
  });

  await runScheduledAiVisibility();

  expect((await repo.getTracker("project"))?.nextCheckAt).toBe(
    "2026-03-08T14:00:00.000Z",
  );
});
