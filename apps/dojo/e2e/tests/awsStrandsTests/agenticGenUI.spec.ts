import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticGenUIPage } from "../../pages/awsStrandsPages/AgenticUIGenPage";

test.describe("Agent Generative UI Feature", () => {
  test("[Strands] should interact with the chat to get a planner on prompt", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const genUIAgent = new AgenticGenUIPage(page);

      await page.goto(
        "/aws-strands/feature/agentic_generative_ui"
      );

      await genUIAgent.openChat();
      await genUIAgent.sendMessage("Hi");
      await genUIAgent.sendButton.click();
      await waitForAIResponse(page);
      await genUIAgent.assertAgentReplyVisible(/Hello/);

      await genUIAgent.sendMessage("give me a plan to make brownies");
      await genUIAgent.sendButton.click();
      await expect(genUIAgent.agentPlannerContainer).toBeVisible({ timeout: 15000 });
      await genUIAgent.plan();

      await page.waitForFunction(
        () => {
          const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
          const lastMessage = messages[messages.length - 1];
          const content = lastMessage?.textContent?.trim() || '';

          return messages.length >= 3 && content.length > 0;
        },
        { timeout: 30000 }
      );
    }, 3, 5000, page);
  });

  test("[Strands] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const genUIAgent = new AgenticGenUIPage(page);

      await page.goto(
        "/aws-strands/feature/agentic_generative_ui"
      );

      await genUIAgent.openChat();
      await genUIAgent.sendMessage("Hi");
      await genUIAgent.sendButton.click();
      await waitForAIResponse(page);
      await genUIAgent.assertAgentReplyVisible(/Hello/);

      await genUIAgent.sendMessage("Go to Mars");
      await genUIAgent.sendButton.click();

      await expect(genUIAgent.agentPlannerContainer).toBeVisible({ timeout: 15000 });
      await genUIAgent.plan();

      await page.waitForFunction(
        () => {
          const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
          const lastMessage = messages[messages.length - 1];
          const content = lastMessage?.textContent?.trim() || '';

          return messages.length >= 3 && content.length > 0;
        },
        { timeout: 30000 }
      );
    }, 3, 5000, page);
  });
});
