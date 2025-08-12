import { test, expect, waitForAIResponse, retryOnAIFailure } from "../../test-isolation-helper";
import { HumanInLoopPage } from "../../pages/serverStarterAllFeaturesPages/HumanInLoopPage";

test.describe("Human in the Loop Feature", () => {
  test(" [Server Starter all features] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);

      await page.goto(
        "/server-starter-all-features/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      await humanInLoop.sendMessage("Hi");
      await humanInLoop.agentGreeting.isVisible();
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 10000 });
      await humanInLoop.performSteps();

      await page.waitForFunction(
        () => {
          const messages = Array.from(document.querySelectorAll('.copilotKitAssistantMessage'));
          const lastMessage = messages[messages.length - 1];
          const content = lastMessage?.textContent?.trim() || '';

          return messages.length >= 2 && content.length > 0;
        },
        { timeout: 30000 }
      );
    });
  });
});