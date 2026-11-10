import { eq } from "drizzle-orm";
import type { createAiVisibilityTestDb } from "@/server/features/ai-visibility/aiVisibilityTestDb";
import {
  aiMatches,
  aiNativeResults,
  aiNativeSources,
  aiObservations,
  aiPrompts,
  aiRuns,
  aiSources,
  aiTrackers,
  member,
  organization,
  projectCompetitors,
  projectContextSections,
  projects,
  user,
} from "@/db/schema";

type TestDb = Awaited<ReturnType<typeof createAiVisibilityTestDb>>;
const at = "2026-11-10T09:00:00.000Z";

export async function seedClientRows(testDb: TestDb) {
  await testDb.seedProject();
  await testDb.db
    .update(projects)
    .set({ name: "Client A", domain: "client-a.example" })
    .where(eq(projects.id, "project"));
  await testDb.db.insert(organization).values({
    id: "target-a",
    name: "Client A restore target",
    slug: "target-a",
    createdAt: new Date(at),
  });
  await testDb.db.insert(projects).values({
    id: "target-a-existing",
    organizationId: "target-a",
    name: "Existing Client A project",
    domain: "existing-a.example",
    createdAt: at,
  });
  const targetUserId = crypto.randomUUID();
  await testDb.db.insert(user).values({
    id: targetUserId,
    name: "Existing Client A target member",
    email: `${targetUserId}@example.test`,
  });
  await testDb.db.insert(member).values({
    id: "member-target-a",
    organizationId: "target-a",
    userId: targetUserId,
    role: "member",
    createdAt: new Date(at),
  });
  await testDb.db.insert(organization).values({
    id: "client-b",
    name: "Client B",
    slug: "client-b",
    createdAt: new Date(at),
  });
  await testDb.db.insert(projects).values({
    id: "project-b",
    organizationId: "client-b",
    name: "Client B project",
    domain: "client-b.example",
    createdAt: at,
  });
  const userId = crypto.randomUUID();
  await testDb.db.insert(user).values({
    id: userId,
    name: "Client B owner",
    email: `${userId}@example.test`,
  });
  await testDb.db.insert(member).values({
    id: "member-b",
    organizationId: "client-b",
    userId,
    role: "owner",
    createdAt: new Date(at),
  });

  await testDb.db.insert(projectContextSections).values({
    projectId: "project",
    key: "business_overview",
    title: null,
    content: "Client A synthetic business context",
    updatedAt: at,
    updatedBy: "user",
  });
  await testDb.db.insert(projectCompetitors).values({
    id: "competitor-a",
    projectId: "project",
    domain: "rival-a.example",
    name: "Rival A",
    notes: null,
    updatedAt: at,
    updatedBy: "user",
  });
  await testDb.db.insert(aiTrackers).values({
    id: "tracker-a",
    projectId: "project",
    enabled: true,
    chatgpt: true,
    gemini: false,
    claude: false,
    perplexity: false,
    googleAiOverview: false,
    locationCode: 2840,
    languageCode: "en",
    scheduleInterval: "weekly",
    nextCheckAt: null,
    lastSkipReason: null,
    createdAt: at,
  });
  await testDb.db.insert(aiPrompts).values([
    {
      id: "prompt-a-v1",
      trackerId: "tracker-a",
      topic: "evaluation",
      text: "Which tool should Client A evaluate?",
      paused: false,
      archived: true,
      createdAt: at,
    },
    {
      id: "prompt-a-v2",
      trackerId: "tracker-a",
      topic: "evaluation",
      text: "What is the latest question version for Client A?",
      paused: false,
      archived: false,
      createdAt: at,
    },
  ]);
  await testDb.db.insert(aiRuns).values([
    {
      id: "run-a-complete",
      trackerId: "tracker-a",
      projectId: "project",
      trigger: "scheduled",
      status: "completed",
      locationCode: 2840,
      languageCode: "en",
      createdAt: at,
      completedAt: at,
    },
    {
      id: "run-a-unknown",
      trackerId: "tracker-a",
      projectId: "project",
      trigger: "scheduled",
      status: "running",
      locationCode: 2840,
      languageCode: "en",
      createdAt: at,
      completedAt: null,
    },
  ]);
  await testDb.db.insert(aiObservations).values([
    {
      id: "observation-a",
      runId: "run-a-complete",
      promptId: "prompt-a-v1",
      engine: "chatgpt",
      branded: false,
      status: "completed",
      collectedAt: at,
      answerMarkdown: "Client A synthetic answer.",
      error: null,
    },
    {
      id: "observation-a-unknown",
      runId: "run-a-unknown",
      promptId: "prompt-a-v2",
      engine: "chatgpt",
      branded: false,
      status: "pending",
      collectedAt: null,
      answerMarkdown: null,
      error: null,
    },
  ]);
  await testDb.db.insert(aiSources).values({
    id: "source-a",
    observationId: "observation-a",
    url: "https://client-a.example/source",
    domain: "client-a.example",
    title: "Client A source",
    position: 0,
  });
  await testDb.db.insert(aiMatches).values({
    id: "match-a",
    observationId: "observation-a",
    name: "Client A",
    domain: "client-a.example",
    own: true,
    mentioned: true,
    cited: true,
    firstMention: 0,
  });
  await testDb.db.insert(aiNativeResults).values([
    {
      id: "native-a-complete",
      schemaVersion: 1,
      clientId: "organization",
      projectId: "project",
      runId: "run-a-complete",
      questionId: "prompt-a-v1",
      questionVersion: 1,
      questionSnapshot: "Which tool should Client A evaluate?",
      requestedModel: "openai/gpt-latest",
      observedModel: "gpt-latest",
      route: "codex_cli",
      resultStatus: "completed",
      answer: "A versioned native answer for Client A.",
      searchStatus: "completed",
      eligibleForVisibility: true,
      errorCode: null,
      turnStatus: null,
      collectedAt: at,
      finalizationToken: "must-not-survive-restore",
    },
    {
      id: "native-a-unknown",
      schemaVersion: 1,
      clientId: "organization",
      projectId: "project",
      runId: "run-a-unknown",
      questionId: "prompt-a-v2",
      questionVersion: 2,
      questionSnapshot: "What is the latest question version for Client A?",
      requestedModel: "openai/gpt-latest",
      observedModel: null,
      route: "codex_cli",
      resultStatus: "pending",
      answer: null,
      searchStatus: "pending",
      eligibleForVisibility: null,
      errorCode: null,
      turnStatus: null,
      collectedAt: at,
      finalizationToken: null,
    },
  ]);
  await testDb.db.insert(aiNativeSources).values({
    id: "native-source-a",
    resultId: "native-a-complete",
    value: "https://client-a.example/native-source",
    position: 0,
  });
}
