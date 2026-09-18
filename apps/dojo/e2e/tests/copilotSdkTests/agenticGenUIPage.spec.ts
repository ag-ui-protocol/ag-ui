import { test, expect } from "./test";
import { AgenticGenUIPage } from "../../pages/crewAIPages/AgenticUIGenPage";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

// Steps stream into state while the model writes the tool arguments
// (PredictState), then the backend tool commits progress with STATE_SNAPSHOTs.
test("[GitHub Copilot SDK] Agentic Gen UI shows and completes the task planner", async ({
  page,
}) => {
  const genUI = new AgenticGenUIPage(page);
  await page.goto(`/${integrationId}/feature/agentic_generative_ui`);
  await genUI.openChat();
  await genUI.sendMessage("Hi");
  await genUI.assertAgentReplyVisible(/Hello/);

  await genUI.sendMessage("Give me a plan to make brownies");
  await expect(genUI.agentPlannerContainer).toBeVisible();
  await genUI.plan();
  const count = await genUI.agentPlannerContainer.getByTestId("task-step-text").count();
  await expect(genUI.agentPlannerContainer).toContainText(`${count}/${count} Complete`, {
    timeout: 30_000,
  });
});
