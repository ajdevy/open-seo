import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  expect,
  type APIRequest,
  type APIRequestContext,
} from "@playwright/test";
import { z } from "zod";
import {
  authorizeOAuth,
  createApiKey,
  listOrganizations,
  signUp,
  type Account,
} from "./auth";
import { check } from "./checks";
import {
  callTool,
  describeResult,
  structured,
  type Credential,
  type ToolCall,
} from "./mcp";
import {
  createdProjectSchema,
  savedKeywordsSchema,
  savedReportSchema,
  savedTemplateSchema,
} from "./schemas";

// Run-unique suffix: emails, the marker and the intruder strings all carry it.
export const RUN = randomBytes(4).toString("hex");
// OAuth client names: A's two grants must be tellable apart in Settings.
export const CLIENT_A = "Isolation Test";
export const CLIENT_A_IN_B = "Isolation Test (B workspace)";
export const KEY_A = "Isolation key A";
export const KEY_A_IN_B = "Isolation key A in B";
// What A tries to write into B's workspace; must never land anywhere.
export const INTRUDER = `intruder-a-${RUN}`;

export type SyntheticAiSeed = {
  promptId: string;
  prompt: string;
  trackerId: string;
  runId: string;
  answerId: string;
  answer: string;
  sourceId: string;
  sourceUrl: string;
  sourceDomain: string;
  sourceTitle: string;
};

export type Tenant = Account & {
  orgId: string;
  orgName: string;
  projectId: string;
  projectName: string;
  projectDomain: string;
  oauth: Credential;
  apiKey: Credential;
  ai: SyntheticAiSeed;
};

export type SeededData = {
  marker: string;
  reportId: string;
  templateId: string;
  keywordIds: string[];
  /** Every B identifier that must never show up in A's responses. */
  secrets: string[];
};

export function reportHtml(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

/** Seed one deterministic legacy answer in the local D1 fixture. */
async function seedSyntheticAi(
  anon: APIRequestContext,
  oauth: Credential,
  projectId: string,
  label: "A" | "B",
): Promise<SyntheticAiSeed> {
  const prompt = `Synthetic ${label} question ${RUN}?`;
  const answer = `synthetic-ai-answer-${label}-${RUN}`;
  const tracker = structured(
    await callTool(anon, oauth, {
      name: "save_ai_visibility_tracker",
      arguments: {
        projectId,
        engines: ["chatgpt"],
        prompts: [{ text: prompt }],
      },
    }),
    z.looseObject({
      data: z.looseObject({
        state: z.looseObject({
          tracker: z.looseObject({ id: z.string() }),
          prompts: z.array(z.looseObject({ id: z.string() })),
        }),
      }),
    }),
    `save ${label} synthetic AI tracker`,
  );
  const trackerId = tracker.data.state.tracker.id;
  const promptId = tracker.data.state.prompts[0]?.id;
  if (!promptId) throw new Error(`No prompt was created for tenant ${label}`);

  const runId = randomUUID();
  const answerId = randomUUID();
  const sourceId = randomUUID();
  const sourceDomain = `source-${label.toLowerCase()}-${RUN}.example.com`;
  const sourceUrl = `https://${sourceDomain}/article-${RUN}`;
  const sourceTitle = `Synthetic ${label} cited source ${RUN}`;
  const createdAt = new Date().toISOString();
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const localD1 = (sql: string) =>
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", sql],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
        stdio: "pipe",
      },
    );

  localD1(
    `INSERT INTO ai_runs (id, tracker_id, project_id, trigger, status, location_code, language_code, created_at, completed_at) VALUES (${quote(runId)}, ${quote(trackerId)}, ${quote(projectId)}, 'manual', 'completed', 2840, 'en', ${quote(createdAt)}, ${quote(createdAt)})`,
  );
  localD1(
    `INSERT INTO ai_observations (id, run_id, prompt_id, engine, branded, status, collected_at, answer_markdown, error) VALUES (${quote(answerId)}, ${quote(runId)}, ${quote(promptId)}, 'chatgpt', 0, 'completed', ${quote(createdAt)}, ${quote(answer)}, NULL)`,
  );
  localD1(
    `INSERT INTO ai_sources (id, observation_id, url, domain, title, position) VALUES (${quote(sourceId)}, ${quote(answerId)}, ${quote(sourceUrl)}, ${quote(sourceDomain)}, ${quote(sourceTitle)}, 1)`,
  );

  return {
    promptId,
    prompt,
    trackerId,
    runId,
    answerId,
    answer,
    sourceId,
    sourceUrl,
    sourceDomain,
    sourceTitle,
  };
}

/**
 * Signs a user up, issues an OAuth grant through the real authorization-code
 * and consent HTTP endpoints, creates an API key and a project.
 */
export async function setupTenant(
  label: "A" | "B",
  deps: {
    request: APIRequest;
    anon: APIRequestContext;
    baseURL: string;
  },
): Promise<Tenant> {
  const account = await signUp(deps.request, deps.baseURL, {
    label,
    name: `${label === "A" ? "Alice" : "Bob"} Isolation ${RUN}`,
    email: `isolation-${label.toLowerCase()}-${RUN}@example.com`,
    password: `Isolation-${RUN}-pass`,
  });
  const chapter = "1 setup";
  const organizations = await listOrganizations(account);
  check({
    chapter,
    credential: `${label} session`,
    tool: "sign-up",
    expectation: "exactly one organization to bind credentials to",
    ok: organizations.length === 1,
    detail: organizations.map((org) => `${org.name} (${org.id})`).join(", "),
  });
  expect(organizations, `${label} has exactly one organization`).toHaveLength(
    1,
  );
  const org = organizations[0];
  const oauth = await authorizeOAuth(deps.anon, account, {
    clientName: CLIENT_A,
  });
  const apiKey = await createApiKey(account, `Isolation key ${label}`);
  const projectName = `Isolation ${label} ${RUN}`;
  const projectDomain = `isolation-${label.toLowerCase()}-${RUN}.example.com`;
  // No organizationId argument: the credential is bound to one workspace.
  const createCall = await callTool(deps.anon, oauth, {
    name: "create_project",
    arguments: { name: projectName, domain: projectDomain },
  });
  check({
    chapter,
    credential: oauth.label,
    tool: "create_project",
    expectation: "accepted without an organizationId argument",
    ok: createCall.isError === false,
    detail: describeResult(createCall),
  });
  const created = structured(
    createCall,
    createdProjectSchema,
    `create_project for ${label}`,
  );
  const ai = await seedSyntheticAi(deps.anon, oauth, created.project.id, label);
  return {
    ...account,
    orgId: org.id,
    orgName: org.name,
    projectId: created.project.id,
    projectName,
    projectDomain,
    oauth,
    apiKey,
    ai,
  };
}

/** B writes its marker into context, a saved keyword, a report and a template. */
export async function seedTenantB(
  anon: APIRequestContext,
  b: Tenant,
): Promise<SeededData> {
  const marker = `secret-b-${RUN}`;
  const projectId = b.projectId;
  const seed = (call: ToolCall) => callTool(anon, b.oauth, call);

  structured(
    await seed({
      name: "update_project_context",
      arguments: {
        projectId,
        updates: [
          { section: "business_overview", content: `Confidential ${marker}` },
        ],
      },
    }),
    z.unknown(),
    "seed project context",
  );
  structured(
    await seed({
      name: "save_keywords",
      arguments: { projectId, keywords: [marker] },
    }),
    z.unknown(),
    "seed saved keyword",
  );
  const keywords = structured(
    await seed({ name: "list_saved_keywords", arguments: { projectId } }),
    savedKeywordsSchema,
    "list seeded keywords",
  );
  const keywordIds = keywords.rows.map((row) => row.id);
  expect(keywordIds.length, "B has a saved keyword").toBeGreaterThan(0);
  const report = structured(
    await seed({
      name: "save_report",
      arguments: {
        projectId,
        title: `Isolation report ${marker}`,
        summary: `Summary with ${marker}`,
        html: reportHtml(`Isolation report ${marker}`, `Body with ${marker}`),
        skill: "isolation-test",
      },
    }),
    savedReportSchema,
    "seed report",
  );
  const template = structured(
    await seed({
      name: "save_report_template",
      arguments: {
        projectId,
        name: `Isolation template ${marker}`,
        description: `Template carrying ${marker}`,
        instructions: `Always mention ${marker}.`,
      },
    }),
    savedTemplateSchema,
    "seed report template",
  );
  return {
    marker,
    reportId: report.reportId,
    templateId: template.templateId,
    keywordIds,
    secrets: [
      marker,
      b.projectId,
      b.projectName,
      b.projectDomain,
      report.reportId,
      template.templateId,
      ...keywordIds,
      b.orgId,
      b.orgName,
      b.email,
      b.ai.trackerId,
      b.ai.promptId,
      b.ai.prompt,
      b.ai.runId,
      b.ai.answerId,
      b.ai.answer,
      b.ai.sourceId,
      b.ai.sourceUrl,
      b.ai.sourceDomain,
      b.ai.sourceTitle,
    ],
  };
}
