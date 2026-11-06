import { aiNativeResultSchema } from "@/types/schemas/ai-native-results";
import { AiNativeResultRepository as repo } from "../repositories/AiNativeResultRepository";

export async function saveAiNativeResult(input: unknown) {
  const result = aiNativeResultSchema.parse(input);
  await repo.persistResult(result);
}

export function loadAiNativeResults(input: {
  projectId: string;
  runIds: string[];
  promptId?: string;
  topic?: string;
}) {
  return repo.listByRuns(
    input.projectId,
    input.runIds,
    input.promptId,
    input.topic,
  );
}
