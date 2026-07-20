import { test, expect } from "../../test-isolation-helper";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

test.describe("Human in the Loop Feature", () => {
  test("[CLI Agent Orchestrator] should interact with the chat and perform steps", async ({
    page,
  }) => {
    const humanInLoop = new HumanInTheLoopPage(page);

    await page.goto("/cli-agent-orchestrator/feature/human_in_the_loop");

    await humanInLoop.openChat();

    await humanInLoop.sendMessage("Hi");

    await humanInLoop.sendMessage(
      "Give me a plan to set up and validate the project",
    );
    await expect(humanInLoop.plan).toBeVisible();

    const itemText = "Run linting checks";
    await humanInLoop.uncheckItem(itemText);
    await humanInLoop.performStepsAndAwait();

    await humanInLoop.sendMessage(
      `Does the plan include ${itemText}? Reply with only words 'Yes' or 'No' (no explanation, no punctuation).`,
    );
  });
});
