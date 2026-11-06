import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization } from "./better-auth-schema";
import { projects } from "./app.schema";

// One tracker per project. Brand name, domain and competitors come from the
// project and its competitors when each answer is matched.
export const aiTrackers = sqliteTable(
  "ai_trackers",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    chatgpt: integer("chatgpt", { mode: "boolean" }).notNull().default(true),
    gemini: integer("gemini", { mode: "boolean" }).notNull().default(false),
    claude: integer("claude", { mode: "boolean" }).notNull().default(false),
    perplexity: integer("perplexity", { mode: "boolean" })
      .notNull()
      .default(false),
    googleAiOverview: integer("google_ai_overview", { mode: "boolean" })
      .notNull()
      .default(false),
    locationCode: integer("location_code").notNull().default(2840),
    languageCode: text("language_code").notNull().default("en"),
    scheduleInterval: text("schedule_interval", {
      enum: ["daily", "weekly", "monthly"],
    })
      .notNull()
      .default("weekly"),
    nextCheckAt: text("next_check_at"),
    lastSkipReason: text("last_skip_reason"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("ai_trackers_project_idx").on(t.projectId),
    index("ai_trackers_due_idx").on(t.enabled, t.nextCheckAt),
  ],
);

// Prompt text never changes: an edit archives the prompt and adds a new one,
// so stored answers always belong to the exact text they were collected for.
export const aiPrompts = sqliteTable(
  "ai_prompts",
  {
    id: text("id").primaryKey(),
    trackerId: text("tracker_id")
      .notNull()
      .references(() => aiTrackers.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    text: text("text").notNull(),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("ai_prompts_tracker_idx").on(t.trackerId)],
);

// A partial unique index allows one queued or running check per tracker, like
// rank_check_runs. A failed INSERT is the "already running" signal.
export const aiRuns = sqliteTable(
  "ai_runs",
  {
    id: text("id").primaryKey(),
    trackerId: text("tracker_id")
      .notNull()
      .references(() => aiTrackers.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    trigger: text("trigger", {
      enum: ["baseline", "scheduled", "manual"],
    }).notNull(),
    status: text("status", {
      enum: ["queued", "running", "completed", "partial", "failed"],
    })
      .notNull()
      .default("queued"),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("ai_runs_project_created_idx").on(t.projectId, t.createdAt),
    uniqueIndex("ai_runs_one_active_idx")
      .on(t.trackerId)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

// One answer per prompt and engine in a run. Rows are created pending when the
// run starts, so the run's size is its row count.
export const aiObservations = sqliteTable(
  "ai_observations",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    promptId: text("prompt_id")
      .notNull()
      .references(() => aiPrompts.id, { onDelete: "cascade" }),
    engine: text("engine", {
      enum: ["chatgpt", "gemini", "google_ai_overview", "claude", "perplexity"],
    }).notNull(),
    // Whether the prompt names the project's own brand when the run started.
    branded: integer("branded", { mode: "boolean" }).notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] })
      .notNull()
      .default("pending"),
    collectedAt: text("collected_at"),
    // Null on a completed row means the engine gave no answer.
    answerMarkdown: text("answer_markdown"),
    error: text("error"),
  },
  (t) => [
    uniqueIndex("ai_observations_run_prompt_engine_idx").on(
      t.runId,
      t.promptId,
      t.engine,
    ),
    index("ai_observations_prompt_idx").on(t.promptId),
  ],
);

// Native adapter results have a distinct model-and-route identity. Keep them
// separate from the legacy engine observations so the legacy uniqueness rule
// and engine enum do not collapse multiple models into one row.
export const aiNativeResults = sqliteTable(
  "ai_native_results",
  {
    id: text("id").primaryKey(),
    schemaVersion: integer("schema_version").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => aiRuns.id, { onDelete: "cascade" }),
    questionId: text("question_id")
      .notNull()
      .references(() => aiPrompts.id, { onDelete: "cascade" }),
    questionVersion: integer("question_version").notNull(),
    questionSnapshot: text("question_snapshot").notNull(),
    requestedModel: text("requested_model").notNull(),
    observedModel: text("observed_model"),
    route: text("route").notNull(),
    resultStatus: text("result_status").notNull(),
    answer: text("answer"),
    searchStatus: text("search_status").notNull(),
    eligibleForVisibility: integer("eligible_for_visibility", {
      mode: "boolean",
    }),
    errorCode: text("error_code"),
    turnStatus: text("turn_status"),
    collectedAt: text("collected_at").notNull(),
    // Fences related writes to the batch that finalizes a pending result.
    finalizationToken: text("finalization_token"),
  },
  (t) => [
    uniqueIndex("ai_native_results_run_question_version_model_route_idx").on(
      t.runId,
      t.questionId,
      t.questionVersion,
      t.requestedModel,
      t.route,
    ),
    index("ai_native_results_project_collected_idx").on(
      t.projectId,
      t.collectedAt,
    ),
  ],
);

// Cited sources and search-result sources are separate relations so their
// roles remain explicit while preserving order and exact source values.
export const aiNativeSources = sqliteTable(
  "ai_native_sources",
  {
    id: text("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => aiNativeResults.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("ai_native_sources_result_position_idx").on(
      t.resultId,
      t.position,
    ),
  ],
);

export const aiNativeSearchSources = sqliteTable(
  "ai_native_search_sources",
  {
    id: text("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => aiNativeResults.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("ai_native_search_sources_result_position_idx").on(
      t.resultId,
      t.position,
    ),
  ],
);

export const aiNativeSearchEvidence = sqliteTable(
  "ai_native_search_evidence",
  {
    id: text("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => aiNativeResults.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    status: text("status").notNull(),
    evidenceRef: text("evidence_ref").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    uniqueIndex("ai_native_search_evidence_result_position_idx").on(
      t.resultId,
      t.position,
    ),
  ],
);

// Pages an answer cites, in the engine's order.
export const aiSources = sqliteTable(
  "ai_sources",
  {
    id: text("id").primaryKey(),
    observationId: text("observation_id")
      .notNull()
      .references(() => aiObservations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    title: text("title"),
    position: integer("position").notNull(),
  },
  (t) => [index("ai_sources_observation_idx").on(t.observationId)],
);

// Each brand's result in one answer. Name and domain are copied from the
// project when the answer is matched, so later edits never rewrite history.
export const aiMatches = sqliteTable(
  "ai_matches",
  {
    id: text("id").primaryKey(),
    observationId: text("observation_id")
      .notNull()
      .references(() => aiObservations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    own: integer("own", { mode: "boolean" }).notNull(),
    mentioned: integer("mentioned", { mode: "boolean" }).notNull(),
    cited: integer("cited", { mode: "boolean" }).notNull(),
    // Character offset of the first mention in the answer's plain text.
    firstMention: integer("first_mention"),
  },
  (t) => [
    uniqueIndex("ai_matches_observation_domain_idx").on(
      t.observationId,
      t.domain,
    ),
  ],
);
