import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect } from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/awsStrandsPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  test("[Strands] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto("/aws-strands/feature/agentic_generative_ui");

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("give me a plan to make brownies");
    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
  });

  test("[Strands] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto("/aws-strands/feature/agentic_generative_ui");

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Go to Mars");

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
  });
});
