import { createAiVisibilityNativeRun } from "@/serverFunctions/ai-visibility";
import type { CreateAiNativeRunInput } from "@/types/schemas/ai-native-results";

export type NativeRunTarget = CreateAiNativeRunInput["targets"][number];

/** Create server-owned pending tasks without starting a provider workflow. */
export function createSyntheticRun(
  projectId: string,
  questionIds: string[],
  targets: NativeRunTarget[],
) {
  return createAiVisibilityNativeRun({
    data: { projectId, questionIds, targets },
  });
}
