import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect, retryOnAIFailure } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/langGraphPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  test.slow();

  test("[LangGraph] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const genUIAgent = new AgenticGenUIPage(page);

      await page.goto(
        "/langgraph/feature/agentic_generative_ui"
      );

      await genUIAgent.openChat();
      await genUIAgent.sendMessage("Hi");
      await genUIAgent.assertAgentReplyVisible(/Hello/);

      await genUIAgent.sendMessage("Give me a plan to make brownies");

      await expect(genUIAgent.agentPlannerContainer).toBeVisible();

      await genUIAgent.plan();
      await awaitLLMResponseDone(page);
    }, 3, 5000, page);
  });

  test("[LangGraph] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const genUIAgent = new AgenticGenUIPage(page);

      await page.goto(
        "/langgraph/feature/agentic_generative_ui"
      );

      await genUIAgent.openChat();
      await genUIAgent.sendMessage("Hi");
      await genUIAgent.assertAgentReplyVisible(/Hello/);

      await genUIAgent.sendMessage("Go to Mars");

      await expect(genUIAgent.agentPlannerContainer).toBeVisible();
      await genUIAgent.plan();
      await awaitLLMResponseDone(page);
    }, 3, 5000, page);
  });
});
