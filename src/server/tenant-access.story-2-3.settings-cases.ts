import { describe, expect, it } from "vitest";
import {
  getProjectContext,
  updateProjectContext,
} from "@/serverFunctions/projectContext";
import {
  getProjectContextTool,
  updateProjectContextTool,
} from "@/server/mcp/tools/project-context";
import { textContent } from "@/server/mcp/tools/tool-test-support";
import { ProjectContextService } from "@/server/features/project-context/services/ProjectContextService";
import {
  expectDeniedWithoutContent,
  mcpContext,
  withApiContext as runWithApiContext,
} from "./tenant-access.story-2-3.test-support";
import {
  story23,
  type Story23TestRuntime,
} from "./tenant-access.story-2-3.test-support";

export function registerProjectSettingsCases(runtime: Story23TestRuntime) {
  const { organizationA, userA, projectA, projectB } = story23;

  const withApiContext = <T>(
    userId: string,
    data: unknown,
    projectScoped: boolean,
    callback: () => Promise<T>,
  ) => runWithApiContext(runtime, userId, data, projectScoped, callback);

  describe("Story 2.3 organization access boundary", () => {
    it("keeps API and MCP project settings separate across organizations", async () => {
      await withApiContext(userA, { projectId: projectA }, true, async () => {
        await updateProjectContext({
          data: {
            projectId: projectA,
            updates: [
              { section: "current_goal", content: "Client A scoped goal." },
              { addCompetitors: [{ domain: "a-api-rival.example.com" }] },
            ],
          },
        });
        const own = await getProjectContext({ data: { projectId: projectA } });
        expect(own.sections).toContainEqual(
          expect.objectContaining({
            key: "current_goal",
            content: "Client A scoped goal.",
          }),
        );
        expect(own.competitors.map((row) => row.domain)).toContain(
          "a-api-rival.example.com",
        );
        expect(JSON.stringify(own)).not.toContain("Client B private settings.");
      });

      await expectDeniedWithoutContent(
        withApiContext(userA, { projectId: projectB }, true, () =>
          getProjectContext({ data: { projectId: projectB } }),
        ),
        { code: "NOT_FOUND" },
        ["Client B private settings.", "Client B", "client-b.synthetic.test"],
      );
      await expectDeniedWithoutContent(
        withApiContext(userA, { projectId: projectB }, true, () =>
          updateProjectContext({
            data: {
              projectId: projectB,
              updates: [
                { section: "current_goal", content: "Unauthorized edit." },
              ],
            },
          }),
        ),
        { code: "NOT_FOUND" },
        ["Client B private settings.", "Client B", "client-b.synthetic.test"],
      );

      const contextA = mcpContext(userA, organizationA);
      await updateProjectContextTool.handler(
        {
          projectId: projectA,
          updates: [
            { section: "positioning", content: "Client A MCP positioning." },
          ],
        },
        contextA,
      );
      const ownContext = await getProjectContextTool.handler(
        { projectId: projectA },
        contextA,
      );
      expect(textContent(ownContext)).toContain("Client A MCP positioning.");
      await expectDeniedWithoutContent(
        getProjectContextTool.handler({ projectId: projectB }, contextA),
        { code: "NOT_FOUND" },
        ["Client B private settings.", "Client B", "client-b.synthetic.test"],
      );
      await expectDeniedWithoutContent(
        updateProjectContextTool.handler(
          {
            projectId: projectB,
            updates: [
              { section: "current_goal", content: "Unauthorized MCP edit." },
            ],
          },
          contextA,
        ),
        { code: "NOT_FOUND" },
        ["Client B private settings.", "Client B", "client-b.synthetic.test"],
      );

      const storedB = await ProjectContextService.getProjectContext(projectB);
      expect(storedB.sections).toContainEqual(
        expect.objectContaining({
          key: "business_overview",
          content: "Client B private settings.",
        }),
      );
      expect(storedB.sections).not.toContainEqual(
        expect.objectContaining({ content: "Unauthorized edit." }),
      );
      expect(storedB.sections).not.toContainEqual(
        expect.objectContaining({ content: "Unauthorized MCP edit." }),
      );
    });
  });
}
