import { test, expect, waitForAIResponse, retryOnAIFailure } from "../../test-isolation-helper";
import { HumanInLoopPage } from "../../pages/langGraphFastAPIPages/HumanInLoopPage";

test.describe("Human in the Loop Feature", () => {
  test("[LangGraph FastAPI] should interact with the chat and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/langgraph-fastapi/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      await humanInLoop.sendMessage("Hi");
      await humanInLoop.agentGreeting.isVisible();

      await humanInLoop.sendMessage(
        "give me a recipe for brownies, there should be only one step with eggs and one step with oven, this is a strict requirement so adhere"
      );
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 10000 });

      const itemText = "eggs";
      await page.waitForTimeout(5000)
      await humanInLoop.uncheckItem(itemText);
      await humanInLoop.performSteps();
      await waitForAIResponse(page);
      await humanInLoop.assertAgentReplyVisible(/oven/i);

      await humanInLoop.sendMessage(
        `Does the planner include ${itemText}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
      await waitForAIResponse(page);
      await humanInLoop.assertAgentReplyVisible(/No/i);
    });
  });

  test("should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    await retryOnAIFailure(async () => {
      const humanInLoop = new HumanInLoopPage(page);

      // Update URL to new domain
      await page.goto(
        "https://ag-ui-dojo-nine.vercel.app/langgraph-fastapi/feature/human_in_the_loop"
      );

      await humanInLoop.openChat();

      await humanInLoop.sendMessage("Hi");
      await humanInLoop.agentGreeting.isVisible();

      // Send a natural planner request like in the first test
      await humanInLoop.sendMessage(
        "Plan a mission to Mars with the first step being Start The Planning"
      );
      await waitForAIResponse(page);
      await expect(humanInLoop.plan).toBeVisible({ timeout: 10000 });

      const uncheckedItem = "Start The Planning";

      // Uncheck the item
      await page.waitForTimeout(5000);
      await humanInLoop.uncheckItem(uncheckedItem);
      await humanInLoop.performSteps();
      await waitForAIResponse(page);

      await humanInLoop.sendMessage(
        `Does the planner include ${uncheckedItem}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
      );
      await waitForAIResponse(page);
      await humanInLoop.assertAgentReplyVisible(/No/i);
    });
  });
});