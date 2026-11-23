import { test, expect } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";
import { HumanInLoopPage } from "../../pages/pydanticAIPages/HumanInLoopPage";

const PAGE_URL = "/cloudflare-agents/feature/human_in_the_loop";

// generate_task_steps is the page's tool: the agent proposes the steps, the
// user unchecks one and confirms, and the page sends the kept steps back as
// the tool result. The fixture answers the follow-up question from that
// result, so the "No" proves the user's choice reached the model.
test.describe("Human in the Loop Feature", () => {
  test("[Cloudflare Agents] should interact with the chat and perform steps", async ({
    page,
  }) => {
    const humanInLoop = new HumanInLoopPage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);

    await humanInLoop.openChat();

    await humanInLoop.sendMessage("Hi");

    await humanInLoop.sendMessage(
      "Give me a plan to make brownies, there should be only one step with eggs and one step with oven, this is a strict requirement so adhere",
    );
    await expect(humanInLoop.plan).toBeVisible();

    const itemText = "eggs";
    await humanInLoop.uncheckItem(itemText);
    await humanInLoop.performStepsAndAwait();

    await humanInLoop.sendMessage(
      `Does the planner include ${itemText}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`,
    );
    await humanInLoop.assertAgentReplyVisible(/^No$/);
  });

  test("[Cloudflare Agents] should interact with the chat using predefined prompts and perform steps", async ({
    page,
  }) => {
    const humanInLoop = new HumanInLoopPage(page);

    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);

    await humanInLoop.openChat();

    await humanInLoop.sendMessage("Hi");
    await humanInLoop.sendMessage(
      "Plan a mission to Mars with the first step being Start The Planning",
    );
    await expect(humanInLoop.plan).toBeVisible();

    const uncheckedItem = "Start The Planning";

    await humanInLoop.uncheckItem(uncheckedItem);
    await humanInLoop.performStepsAndAwait();

    await humanInLoop.sendMessage(
      `Does the planner include ${uncheckedItem}? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`,
    );
    await humanInLoop.assertAgentReplyVisible(/^No$/);
  });
});
