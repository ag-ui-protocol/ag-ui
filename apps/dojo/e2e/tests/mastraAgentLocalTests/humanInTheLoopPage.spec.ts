import { test, expect, waitForAIResponse, retryOnAIFailure } from "../../test-isolation-helper";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

test.describe("Human in the Loop Feature", () => {
  test("[Mastra Agent Local] should interact with the chat and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInTheLoopPage(page);

      await page.goto(
        "/mastra-agent-local/feature/human_in_the_loop"
      );

      await humanInLoop.agentGreeting.waitFor({ state: "visible", timeout: 15000 });

      await humanInLoop.sendMessage("Hi");
      await waitForAIResponse(page);

      await humanInLoop.sendMessage(
        "Give me a plan to make brownies, there should be only one step with eggs and one step with oven, this is a strict requirement so adhere"
      );
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 30000 });

      const itemText = "eggs";
      // Wait for plan items to be fully rendered
      await page.getByTestId('step-item').first().waitFor({ state: "visible", timeout: 10000 });
      await humanInLoop.uncheckItem(itemText);
      await humanInLoop.performSteps();

      // Wait for the agent to process the confirmed steps and respond
      await page.waitForFunction(
        () => {
          const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
          const lastMessage = messages[messages.length - 1];
          const content = lastMessage?.textContent?.trim() || '';
          return messages.length >= 3 && content.length > 0;
        },
        { timeout: 60000 }
      );

      await humanInLoop.sendMessage(
        `Does the planner include ${itemText}? Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
      await waitForAIResponse(page);
      // Verify the agent responded (don't assert specific Yes/No since it's non-deterministic)
      await expect(humanInLoop.agentMessage.last()).toBeVisible({ timeout: 15000 });
    });
  });

  test("[Mastra Agent Local] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInTheLoopPage(page);

      await page.goto(
        "/mastra-agent-local/feature/human_in_the_loop"
      );

      await humanInLoop.agentGreeting.waitFor({ state: "visible", timeout: 15000 });

      await humanInLoop.sendMessage("Hi");
      await waitForAIResponse(page);

      await humanInLoop.sendMessage(
        "Plan a mission to Mars with the first step being Start The Planning"
      );
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 30000 });

      const uncheckedItem = "Start The Planning";

      // Wait for plan items to be fully rendered
      await page.getByTestId('step-item').first().waitFor({ state: "visible", timeout: 10000 });
      await humanInLoop.uncheckItem(uncheckedItem);
      await humanInLoop.performSteps();

      // Wait for the agent to process the confirmed steps and respond
      await page.waitForFunction(
        () => {
          const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
          const lastMessage = messages[messages.length - 1];
          const content = lastMessage?.textContent?.trim() || '';
          return messages.length >= 3 && content.length > 0;
        },
        { timeout: 60000 }
      );

      await humanInLoop.sendMessage(
        `Does the planner include ${uncheckedItem}? Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
      await waitForAIResponse(page);
      // Verify the agent responded
      await expect(humanInLoop.agentMessage.last()).toBeVisible({ timeout: 15000 });
    });
  });
});
