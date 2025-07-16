import { test, expect, waitForAIResponse, retryOnAIFailure } from "../../test-isolation-helper";
import { HumanInLoopPage } from "../../pages/serverStarterAllFeaturesPages/HumanInLoopPage";

test.describe("Human in the Loop Feature", () => {

  test(" [Server Starter all features] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/server-starter-all-features/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      await humanInLoop.sendMessage("Hi");
      await humanInLoop.agentGreeting.isVisible();
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 10000 });
      await humanInLoop.performSteps();
      await waitForAIResponse(page);
      await humanInLoop.assertAgentReplyVisible(/Ok! I'm working on it./i);
    });
  });
});