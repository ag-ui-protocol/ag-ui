import { test, expect } from "../../test-isolation-helper";
import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

test.describe("Human in the Loop Feature", () => {
  test("[Claude Agent SDK Python] should interact with the chat and perform steps", async ({
    page,
  }) => {
    test.slow();
    const humanInLoop = new HumanInTheLoopPage(page);
    await page.goto("/claude-agent-sdk-python/feature/human_in_the_loop");
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

  test("[Claude Agent SDK Python] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    test.slow();
    const humanInLoop = new HumanInTheLoopPage(page);
    await page.goto("/claude-agent-sdk-python/feature/human_in_the_loop");
    await humanInLoop.openChat();
    await humanInLoop.sendMessage("Hi");
    await humanInLoop.sendMessage(
      "Plan a mission to Mars with the first step being Start The Planning"
    );
    await expect(humanInLoop.plan).toBeVisible();
    const uncheckedItem = "Start The Planning";
    await humanInLoop.uncheckItem(uncheckedItem);
    await humanInLoop.performSteps();
    await awaitLLMResponseDone(page);
    await humanInLoop.sendMessage(
      `Does the planner include ${uncheckedItem}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`
    );
  });
});
