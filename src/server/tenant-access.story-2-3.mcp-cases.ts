import { describe, expect, it } from "vitest";
import {
  getAiVisibilityAnswerTool,
  getAiVisibilityResultsTool,
  getAiVisibilityRunTool,
  getAiVisibilitySourcesTool,
  runAiVisibilityCheckTool,
} from "@/server/mcp/tools/ai-visibility-tools";
import { getProjectContextTool } from "@/server/mcp/tools/project-context";
import { textContent } from "@/server/mcp/tools/tool-test-support";
import {
  expectDeniedWithoutContent,
  mcpContext,
} from "./tenant-access.story-2-3.test-support";
import {
  aiAnswerSchema,
  aiResultsSchema,
  aiSourcesSchema,
} from "@/types/schemas/ai-visibility";
import {
  story23,
  type Story23TestRuntime,
} from "./tenant-access.story-2-3.test-support";

export function registerMcpAccessCases(runtime: Story23TestRuntime) {
  const {
    organizationA,
    organizationB,
    userA,
    userB,
    projectA,
    projectB,
    runA,
    runB,
    answerAId,
    answerBId,
    answerA,
    answerB,
    sourceA,
    sourceB,
  } = story23;

  describe("Story 2.3 organization access boundary", () => {
    it("limits MCP result, answer, source, and launch access before foreign content or work is exposed", async () => {
      const contextA = mcpContext(userA, organizationA);
      const ownRun = await getAiVisibilityRunTool.handler(
        { projectId: projectA, runId: runA },
        contextA,
      );
      expect(ownRun.isError).not.toBe(true);
      expect(textContent(ownRun)).toContain(`Run ${runA}`);
      const ownResults = await getAiVisibilityResultsTool.handler(
        aiResultsSchema.parse({
          projectId: projectA,
          runId: runA,
          branded: "all",
        }),
        contextA,
      );
      expect(ownResults.structuredContent).toMatchObject({
        data: { rows: [{ prompt: "Client A private question?" }] },
      });
      expect(textContent(ownResults)).not.toContain(answerB);

      const ownAnswer = await getAiVisibilityAnswerTool.handler(
        aiAnswerSchema.parse({ projectId: projectA, observationId: answerAId }),
        contextA,
      );
      expect(ownAnswer.structuredContent).toMatchObject({
        data: { answerText: answerA },
      });
      const ownSources = await getAiVisibilitySourcesTool.handler(
        aiSourcesSchema.parse({
          projectId: projectA,
          runId: runA,
          branded: "all",
        }),
        contextA,
      );
      expect(JSON.stringify(ownSources.structuredContent)).toContain(sourceA);
      expect(JSON.stringify(ownSources.structuredContent)).not.toContain(
        sourceB,
      );

      const ownContext = await getProjectContextTool.handler(
        { projectId: projectA },
        contextA,
      );
      expect(textContent(ownContext)).toContain("Client A private settings.");
      expect(textContent(ownContext)).not.toContain(
        "Client B private settings.",
      );

      const foreignRun = await getAiVisibilityRunTool.handler(
        { projectId: projectA, runId: runB },
        contextA,
      );
      expect(foreignRun.isError).toBe(true);
      expect(textContent(foreignRun)).not.toContain(answerB);
      expect(textContent(foreignRun)).not.toContain(
        "Client B private question?",
      );
      expect(textContent(foreignRun)).not.toContain(projectB);
      const foreignAnswer = await getAiVisibilityAnswerTool.handler(
        { projectId: projectA, observationId: answerBId },
        contextA,
      );
      expect(foreignAnswer.isError).toBe(true);
      expect(textContent(foreignAnswer)).not.toContain(answerB);
      expect(textContent(foreignAnswer)).not.toContain("Client B");
      expect(textContent(foreignAnswer)).not.toContain(sourceB);
      const foreignSources = await getAiVisibilitySourcesTool.handler(
        aiSourcesSchema.parse({
          projectId: projectA,
          runId: runB,
          branded: "all",
        }),
        contextA,
      );
      expect(foreignSources.isError).toBe(true);
      expect(textContent(foreignSources)).not.toContain(sourceB);
      expect(textContent(foreignSources)).not.toContain("Client B");
      expect(textContent(foreignSources)).not.toContain(projectB);

      await expectDeniedWithoutContent(
        getAiVisibilityResultsTool.handler(
          aiResultsSchema.parse({
            projectId: projectB,
            runId: runB,
            branded: "all",
          }),
          contextA,
        ),
        { code: "NOT_FOUND" },
        [answerB, "Client B", "client-b.synthetic.test", projectB],
      );
      await expectDeniedWithoutContent(
        runAiVisibilityCheckTool.handler(
          { projectId: projectB, maxCostUsd: 1 },
          contextA,
        ),
        { code: "NOT_FOUND" },
        [answerB, "Client B", "client-b.synthetic.test", projectB],
      );
      expect(runtime.workflow.create).not.toHaveBeenCalled();

      const ownB = await getAiVisibilityResultsTool.handler(
        aiResultsSchema.parse({
          projectId: projectB,
          runId: runB,
          branded: "all",
        }),
        mcpContext(userB, organizationB),
      );
      expect(ownB.structuredContent).toMatchObject({
        data: { rows: [{ prompt: "Client B private question?" }] },
      });
    });
  });
}
