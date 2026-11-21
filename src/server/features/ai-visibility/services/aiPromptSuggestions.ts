import { AiVisibilityRepository as repo } from "../repositories/AiVisibilityRepository";
import { aiTopics } from "./aiVisibilityConfiguration";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  checkUsageCreditsDepleted,
  type BillingCustomerContext,
} from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";
import { normalizeAiSuggestion } from "@/shared/ai-prompt-suggestions";
import { AiVisibilityError } from "./aiVisibilityErrors";
import type { GenerateAiPromptsInput } from "@/types/schemas/aiPromptSuggestions";

export async function generateAiPrompts(
  input: GenerateAiPromptsInput,
  customer: BillingCustomerContext,
): Promise<{ topic: string; prompts: string[] }> {
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    customer.organizationId,
  );
  if (!project) throw new AppError("NOT_FOUND");
  if (!project.domain)
    throw new AppError(
      "VALIDATION_ERROR",
      "Set your project's website before generating prompts.",
    );
  const config = await repo.getConfiguration(input.projectId);
  const topics = config ? aiTopics(config) : [];
  const unarchived = config?.prompts.filter((prompt) => !prompt.archived) ?? [];
  // A typed name matching a saved topic adds to that topic.
  const sameTopic = (name: string) =>
    topics.find(
      (topic) => normalizeAiSuggestion(topic) === normalizeAiSuggestion(name),
    );
  const requested = input.topic?.trim();
  const topicName = requested ? (sameTopic(requested) ?? requested) : undefined;
  if (!(topicName && sameTopic(topicName)) && topics.length >= 30)
    throw new AppError(
      "VALIDATION_ERROR",
      "Archive the prompts of an unused topic before generating a new one.",
    );
  if (unarchived.length >= 100)
    throw new AppError(
      "VALIDATION_ERROR",
      "Archive unused prompts before generating more.",
    );
  if (
    (await isHostedServerAuthMode()) &&
    (await checkUsageCreditsDepleted(customer)).depleted
  )
    throw new AppError(
      "INSUFFICIENT_CREDITS",
      "You need usage credits to generate prompts.",
    );
  throw new AiVisibilityError(
    "PROVIDER_COST_CEILING_UNAVAILABLE",
    "Prompt generation cannot start until its OpenRouter cost can be reserved against the shared provider budget. No provider request was started.",
  );
}
