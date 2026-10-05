import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/pydanticAIPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  test("[Antigravity] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto("/antigravity/feature/agentic_generative_ui");

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Give me a plan to make brownies");
    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
    // The server tool marks each step completed as it goes.
    await expect(genUIAgent.agentPlannerContainer).toContainText("4/4 Complete");
  });

  test("[Antigravity] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto("/antigravity/feature/agentic_generative_ui");

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Go to Mars");

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
    await expect(genUIAgent.agentPlannerContainer).toContainText("4/4 Complete");
  });
});
