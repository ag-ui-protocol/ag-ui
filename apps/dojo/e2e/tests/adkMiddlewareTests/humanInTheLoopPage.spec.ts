import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { test, expect, retryOnAIFailure } from "../../test-isolation-helper";
import { HumanInLoopPage } from "../../pages/adkMiddlewarePages/HumanInLoopPage";

test.describe("Human in the Loop Feature", () => {
  test.slow(); // Multi-step AI test: needs extra time for retries
  test("[ADK Middleware] should interact with the chat and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);

      await page.goto(
        "/adk-middleware/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      await humanInLoop.sendMessage("Hi");

      await humanInLoop.sendMessage(
        "Give me a plan to make brownies, there should be only one step with eggs and one step with oven, this is a strict requirement so adhere"
      );
      await expect(humanInLoop.plan).toBeVisible();

      const itemText = "eggs";
      await humanInLoop.uncheckItem(itemText);
      await humanInLoop.performSteps();
      await awaitLLMResponseDone(page);

      await humanInLoop.sendMessage(
        `Does the planner include ${itemText}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
    });
  });

  test("[ADK Middleware] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);

      await page.goto(
        "/adk-middleware/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      // Click the predefined "Simple plan" suggestion button
      const simplePlanButton = page.getByRole("button", { name: "Simple plan" });
      await expect(simplePlanButton).toBeVisible();
      await simplePlanButton.click();
      await awaitLLMResponseDone(page);
      await expect(humanInLoop.plan).toBeVisible();

      // Uncheck the first step by index
      const uncheckedItem = await humanInLoop.uncheckItem(0);
      await humanInLoop.performSteps();
      await awaitLLMResponseDone(page);

      await humanInLoop.sendMessage(
        `Does the planner include ${uncheckedItem}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
    });
  });
});
