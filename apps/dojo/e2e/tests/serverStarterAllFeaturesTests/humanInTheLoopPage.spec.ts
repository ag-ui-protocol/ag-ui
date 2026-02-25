import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect, retryOnAIFailure } from "../../test-isolation-helper";
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
      await expect(humanInLoop.plan).toBeVisible();
      await humanInLoop.performSteps();
      await awaitLLMResponseDone(page);
    });
  });
});