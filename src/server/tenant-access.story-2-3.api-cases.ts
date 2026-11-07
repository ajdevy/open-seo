import { describe, expect, it } from "vitest";
import {
  getAiVisibilityAnswer,
  getAiVisibilityResults,
  getAiVisibilitySources,
  getAiVisibilityRun,
  runAiVisibilityCheck,
} from "@/serverFunctions/ai-visibility";
import { getProjectAccess } from "@/serverFunctions/projects";
import {
  expectDeniedWithoutContent,
  withApiContext as runWithApiContext,
} from "./tenant-access.story-2-3.test-support";
import {
  story23,
  type Story23TestRuntime,
} from "./tenant-access.story-2-3.test-support";

export function registerApiAccessCases(runtime: Story23TestRuntime) {
  const {
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

  const withApiContext = <T>(
    userId: string,
    data: unknown,
    projectScoped: boolean,
    callback: () => Promise<T>,
  ) => runWithApiContext(runtime, userId, data, projectScoped, callback);

  describe("Story 2.3 organization access boundary", () => {
    it("limits API project, result, answer, source, and launch access to the authenticated organization", async () => {
      const ownProject = await withApiContext(
        userA,
        { projectId: projectA },
        false,
        () => getProjectAccess({ data: { projectId: projectA } }),
      );
      expect(ownProject).toMatchObject({
        id: projectA,
        name: "Client A",
        domain: "client-a.synthetic.test",
      });

      await expectDeniedWithoutContent(
        withApiContext(userA, { projectId: projectB }, true, () =>
          runAiVisibilityCheck({
            data: { projectId: projectB, maxCostUsd: 1 },
          }),
        ),
        { code: "NOT_FOUND" },
        [answerB, "Client B", "client-b.synthetic.test", projectB],
      );
      expect(runtime.workflow.create).not.toHaveBeenCalled();

      await expectDeniedWithoutContent(
        withApiContext(userA, { projectId: projectB }, false, () =>
          getProjectAccess({ data: { projectId: projectB } }),
        ),
        { code: "NOT_FOUND" },
        ["Client B", "client-b.synthetic.test", projectB],
      );

      const ownResults = await withApiContext(
        userA,
        { projectId: projectA },
        true,
        () =>
          getAiVisibilityResults({
            data: { projectId: projectA, runId: runA, branded: "all" },
          }),
      );
      const ownRun = await withApiContext(
        userA,
        { projectId: projectA },
        true,
        () =>
          getAiVisibilityRun({ data: { projectId: projectA, runId: runA } }),
      );
      expect(ownRun.id).toBe(runA);
      expect(ownResults.rows[0]).toMatchObject({
        prompt: "Client A private question?",
      });
      expect(JSON.stringify(ownResults)).not.toContain(answerB);

      const ownAnswer = await withApiContext(
        userA,
        { projectId: projectA },
        true,
        () =>
          getAiVisibilityAnswer({
            data: { projectId: projectA, observationId: answerAId },
          }),
      );
      expect(ownAnswer.answerText).toBe(answerA);
      const ownSources = await withApiContext(
        userA,
        { projectId: projectA },
        true,
        () =>
          getAiVisibilitySources({
            data: { projectId: projectA, runId: runA, branded: "all" },
          }),
      );
      expect(ownSources.rows.map((row) => row.url)).toContain(sourceA);
      expect(JSON.stringify(ownSources)).not.toContain(sourceB);

      await withApiContext(userB, { projectId: projectB }, true, async () => {
        const result = await getAiVisibilityResults({
          data: { projectId: projectB, runId: runB, branded: "all" },
        });
        expect(result.rows[0].prompt).toBe("Client B private question?");
      });

      await withApiContext(userA, { projectId: projectA }, true, async () => {
        await expectDeniedWithoutContent(
          getAiVisibilityRun({ data: { projectId: projectA, runId: runB } }),
          { reason: "RUN_NOT_FOUND" },
          [answerB, "Client B", "client-b.synthetic.test"],
        );
        await expectDeniedWithoutContent(
          getAiVisibilityResults({
            data: { projectId: projectA, runId: runB, branded: "all" },
          }),
          { reason: "RUN_NOT_FOUND" },
          [answerB, "Client B", "client-b.synthetic.test"],
        );
        await expectDeniedWithoutContent(
          getAiVisibilityAnswer({
            data: { projectId: projectA, observationId: answerBId },
          }),
          { reason: "ANSWER_NOT_FOUND" },
          [answerB, "Client B", "client-b.synthetic.test", sourceB],
        );
        await expectDeniedWithoutContent(
          getAiVisibilitySources({
            data: { projectId: projectA, runId: runB, branded: "all" },
          }),
          { reason: "RUN_NOT_FOUND" },
          [sourceB, "Client B", "client-b.synthetic.test"],
        );
      });
    });
  });
}
