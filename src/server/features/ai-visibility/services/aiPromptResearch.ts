import { sortBy } from "remeda";
import { z } from "zod";
import {
  checkUsageCreditsDepleted,
  type BillingCustomerContext,
} from "@/server/billing/subscription";
import { assertPaidAiSearchPlan } from "@/server/features/ai-search/services/access";
import { ProjectContextRepository } from "@/server/features/project-context/repositories/ProjectContextRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  CHATGPT_LANGUAGE_CODE,
  CHATGPT_LOCATION_CODE,
} from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import { buildCacheKey, getCached } from "@/server/lib/r2-cache";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import {
  AI_DEFAULT_TOPIC,
  type AiPromptResearchResult,
  type AiResearchedPrompt,
} from "@/shared/ai-visibility";
import type { ResearchAiPromptsInput } from "@/types/schemas/aiPromptResearch";
import { aiPromptIsBranded, ownedAiDomain } from "./aiVisibilityMatching";
import { AiVisibilityError } from "./aiVisibilityErrors";
import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { getTracker } from "./aiVisibilityState";

// Enough of the answer to show which meaning of the keyword it is about.
const RELEVANCE_ANSWER_CHARS = 300;

// Only the fields research reads. Brand and tracked flags are derived on every
// request, so one cached provider response serves every project in the org.
// The provider's AI search volume is only used to order prompts: it is
// estimated from Google "People also ask" data, not counted from AI usage.
const cachedPromptSchema = z.object({
  question: z.string(),
  answer: z.string(),
  volume: z.number(),
  sources: z.array(
    z.object({
      domain: z.string(),
      url: z.string(),
      title: z.string().nullable(),
    }),
  ),
});
type CachedPrompt = z.infer<typeof cachedPromptSchema>;
const cachedResearchSchema = z.object({
  prompts: z.array(cachedPromptSchema),
});
type CachedResearch = z.infer<typeof cachedResearchSchema>;
/** Website setup keywords first, then tracker topics the user added. */
export async function listAiResearchKeywords(input: {
  projectId: string;
}): Promise<{ keywords: string[] }> {
  const [state, researchKeywords] = await Promise.all([
    getTracker({ projectId: input.projectId }),
    repo.listResearchKeywords(input.projectId),
  ]);
  const keywords = [
    ...researchKeywords,
    // The default topic is a catch-all, not a keyword.
    ...state.topics.filter((topic) => topic !== AI_DEFAULT_TOPIC),
  ].map(normalizeAiSuggestion);
  return { keywords: [...new Set(keywords)] };
}

export async function researchAiPrompts(
  input: ResearchAiPromptsInput,
  customer: BillingCustomerContext,
): Promise<AiPromptResearchResult> {
  await assertPaidAiSearchPlan(customer.organizationId, "Prompt Research");
  // Serve prompt and relevance data from cache only until both provider costs
  // can be reserved through the shared rolling budget.
  if (
    (await isHostedServerAuthMode()) &&
    (await checkUsageCreditsDepleted(customer)).depleted
  )
    throw new AppError(
      "INSUFFICIENT_CREDITS",
      "You need usage credits to research prompts.",
    );
  const state = await getTracker({ projectId: input.projectId });
  const keyword = normalizeAiSuggestion(input.keyword);
  // DataForSEO has ChatGPT prompt data only in US English.
  const loaded = await loadPrompts(
    {
      topic: keyword,
      platform: "chat_gpt",
      locationCode: CHATGPT_LOCATION_CODE,
      languageCode: CHATGPT_LANGUAGE_CODE,
    },
    customer,
  );
  const ownBrand = state.brands.find((brand) => brand.own);
  const tracked = new Set(
    state.prompts
      .filter((prompt) => !prompt.archived)
      .map((prompt) => normalizeAiSuggestion(prompt.text)),
  );
  const relevant = await relevantQuestions(
    {
      projectId: input.projectId,
      keyword,
      prompts: loaded.prompts,
    },
    customer,
  );
  const prompts = mergeNearDuplicates(
    loaded.prompts.filter((item) => relevant.has(item.question)),
  ).map((group): AiResearchedPrompt => {
    const [top] = group;
    const sources = uniqueSources(group).map((source) => ({
      ...source,
      own: !!ownBrand && ownedAiDomain(source.domain, ownBrand.domain),
    }));
    return {
      text: capitalize(top.question),
      variants: group.slice(1).map((item) => capitalize(item.question)),
      sources,
      ownDomainCited: sources.some((source) => source.own),
      brandMentioned:
        !!ownBrand &&
        group.some((item) => aiPromptIsBranded(item.answer, ownBrand)),
      tracked: group.some((item) =>
        tracked.has(normalizeAiSuggestion(item.question)),
      ),
    };
  });
  return { keyword: input.keyword, prompts };
}

async function loadPrompts(
  request: {
    topic: string;
    platform: "chat_gpt";
    locationCode: number;
    languageCode: string;
  },
  customer: BillingCustomerContext,
): Promise<CachedResearch> {
  const cacheKey = await buildCacheKey("ai-visibility:prompt-research", {
    organizationId: customer.organizationId,
    ...request,
  });
  const cached = cachedResearchSchema.safeParse(await getCached(cacheKey));
  if (cached.success) return cached.data;
  throw new AiVisibilityError(
    "PROVIDER_COST_CEILING_UNAVAILABLE",
    "Prompt research cannot start until its DataForSEO cost can be reserved against the shared provider budget. No provider request was started.",
  );
}

/** Return a cached relevance decision or fail closed before an OpenRouter call. */
async function relevantQuestions(
  input: {
    projectId: string;
    keyword: string;
    prompts: CachedPrompt[];
  },
  customer: BillingCustomerContext,
): Promise<Set<string>> {
  if (!input.prompts.length) return new Set();
  const [project, sections] = await Promise.all([
    ProjectRepository.getProjectForOrganization(
      input.projectId,
      customer.organizationId,
    ),
    ProjectContextRepository.listSections(input.projectId),
  ]);
  const overview = sections
    .find((section) => section.key === "business_overview")
    ?.content.slice(0, 3500);
  const prompt = JSON.stringify({
    business: { name: project?.name, domain: project?.domain, overview },
    keyword: input.keyword,
    questions: input.prompts.map((item, id) => ({
      id,
      question: item.question,
      answer: item.answer.slice(0, RELEVANCE_ANSWER_CHARS),
    })),
  });
  // Keyed on the exact model input, so any change to the business or the
  // provider's questions gets a fresh verdict.
  const cacheKey = await buildCacheKey("ai-visibility:prompt-relevance", {
    projectId: input.projectId,
    prompt,
  });
  const cached = z.array(z.string()).safeParse(await getCached(cacheKey));
  if (cached.success) return new Set(cached.data);
  throw new AiVisibilityError(
    "PROVIDER_COST_CEILING_UNAVAILABLE",
    "Prompt relevance cannot start until its OpenRouter cost can be reserved against the shared provider budget. No provider request was started.",
  );
}

// "…most accurate?" and "…the most accurate?", or the same question with
// different years, ask the same thing. The highest-volume wording leads.
function mergeKey(question: string) {
  return words(question.replace(/\b(?:in\s+|for\s+)?(?:19|20)\d{2}\b/g, " "))
    .filter((word) => !["a", "an", "any", "the"].includes(word))
    .join(" ");
}

// The provider lowercases questions; tracked prompts read better as sentences.
function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lowercase words with a trailing plural "s" removed. */
function words(text: string) {
  return normalizeAiSuggestion(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    );
}

function mergeNearDuplicates(prompts: CachedPrompt[]): CachedPrompt[][] {
  const groups = new Map<string, CachedPrompt[]>();
  for (const prompt of sortBy(prompts, [(item) => item.volume, "desc"])) {
    const key = mergeKey(prompt.question);
    groups.set(key, [...(groups.get(key) ?? []), prompt]);
  }
  return [...groups.values()];
}

function uniqueSources(group: CachedPrompt[]) {
  const byUrl = new Map<string, CachedPrompt["sources"][number]>();
  for (const source of group.flatMap((item) => item.sources))
    if (!byUrl.has(source.url)) byUrl.set(source.url, source);
  return [...byUrl.values()];
}
