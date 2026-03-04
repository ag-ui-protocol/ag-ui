import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect, retryOnAIFailure } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/llamaIndexPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  test.slow();

  // Fails. Issue with integration or something.
  test("[LlamaIndex] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const genUIAgent = new AgenticGenUIPage(page);

      await page.goto(
        "/llama-index/feature/agentic_generative_ui"
      );

      await genUIAgent.openChat();
      await genUIAgent.sendMessage("Hi");
      await genUIAgent.assertAgentReplyVisible(/Hello/);

      await genUIAgent.sendMessage("Give me a plan to make brownies using your tools");

      await expect(genUIAgent.agentPlannerContainer).toBeVisible();

      await genUIAgent.plan();
      await awaitLLMResponseDone(page);
    }, 3, 5000, page);
  });

  // Fails. Issue with integration or something.
  test("[LlamaIndex] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const genUIAgent = new AgenticGenUIPage(page);

      await page.goto(
        "/llama-index/feature/agentic_generative_ui"
      );

      await genUIAgent.openChat();
      await genUIAgent.sendMessage("Hi");
      await genUIAgent.assertAgentReplyVisible(/Hello/);

      await genUIAgent.sendMessage("Go to Mars using your tools");

      await expect(genUIAgent.agentPlannerContainer).toBeVisible();

      await genUIAgent.plan();
      await awaitLLMResponseDone(page);
    }, 3, 5000, page);
  });
});
