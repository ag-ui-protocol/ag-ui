import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect } from "@playwright/test";
import { AgenticGenUIPage } from "../../pages/pydanticAIPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  // Flaky. Sometimes the steps render but never process.
  test("[PydanticAI] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "/pydantic-ai/feature/agentic_generative_ui"
    );

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.sendButton.click();
    await genUIAgent.assertAgentReplyVisible([/Hello/, /Hi/]);

    await genUIAgent.sendMessage("give me a plan to make brownies");
    await genUIAgent.sendButton.click();
    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
  });

  test("[PydanticAI] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const genUIAgent = new AgenticGenUIPage(page);

    await page.goto(
      "/pydantic-ai/feature/agentic_generative_ui"
    );

    await genUIAgent.openChat();
    await genUIAgent.sendMessage("Hi");
    await genUIAgent.sendButton.click();
    await genUIAgent.assertAgentReplyVisible(/Hello/);

    await genUIAgent.sendMessage("Go to Mars");
    await genUIAgent.sendButton.click();

    await expect(genUIAgent.agentPlannerContainer).toBeVisible();
    await genUIAgent.plan();
    await awaitLLMResponseDone(page);
  });
});