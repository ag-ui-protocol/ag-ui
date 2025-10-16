import { test, expect, waitForAIResponse, retryOnAIFailure } from "../../test-isolation-helper";
import { HumanInLoopPage } from "../../pages/langGraphPages/HumanInLoopPage";

test.describe("Human in the Loop Feature", () => {
  test("[LangGraph] should interact with the chat and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);

      await page.goto(
        "/langgraph-typescript/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      await humanInLoop.sendMessage("Hi");
      await humanInLoop.agentGreeting.isVisible();

      await humanInLoop.sendMessage(
        "Give me a plan to make brownies, there should be only one step with eggs and one step with oven, this is a strict requirement so adhere"
      );
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 10000 });

      const itemText = "eggs";
      await page.waitForTimeout(5000);
      await humanInLoop.uncheckItem(itemText);
      await humanInLoop.performSteps();
      await page.waitForFunction(
        () => {
          const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
          const lastMessage = messages[messages.length - 1];
          const content = lastMessage?.textContent?.trim() || '';
          
          return messages.length >= 3 && content.length > 0;
        },
        { timeout: 30000 }
      );

      await humanInLoop.sendMessage(
        `Does the planner include ${itemText}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
      await waitForAIResponse(page);
    });
  });

  test("should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);
      await page.goto(
        "/langgraph-typescript/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      await humanInLoop.sendMessage("Hi");
      await humanInLoop.agentGreeting.isVisible();

      await humanInLoop.sendMessage(
        "Plan a mission to Mars with the first step being Start The Planning"
      );
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 10000 });

      const uncheckedItem = "Start The Planning";

      await page.waitForTimeout(5000);
      await humanInLoop.uncheckItem(uncheckedItem);
      await humanInLoop.performSteps();
      
      await page.waitForFunction(
        () => {
          const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
          const lastMessage = messages[messages.length - 1];
          const content = lastMessage?.textContent?.trim() || '';
          
          return messages.length >= 3 && content.length > 0;
        },
        { timeout: 30000 }
      );

      await humanInLoop.sendMessage(
        `Does the planner include ${uncheckedItem}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
      await waitForAIResponse(page);
    });
  });
});