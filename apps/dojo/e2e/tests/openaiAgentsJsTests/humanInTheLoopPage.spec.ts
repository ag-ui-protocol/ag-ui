import { expect, test } from "../../test-isolation-helper";
import { awaitResponseAfterAction } from "../../utils/copilot-actions";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

test("[OpenAI Agents JS] Human in the Loop edits and performs a plan", async ({
  page,
}) => {
  test.slow();
  const humanInTheLoop = new HumanInTheLoopPage(page);

  await page.goto("/openai-agents-js/feature/human_in_the_loop");
  await humanInTheLoop.openChat();
  await humanInTheLoop.sendMessage(
    "Plan a mission to Mars with the first step being Start The Planning",
  );
  const plan = humanInTheLoop.agentMessage.getByTestId("select-steps");
  await expect(plan).toBeVisible();
  await humanInTheLoop.uncheckItem("Start The Planning");
  await expect(
    plan.getByRole("checkbox", { name: "Start The Planning" }),
  ).not.toBeChecked();
  await awaitResponseAfterAction(page, () => humanInTheLoop.performSteps());
  await expect(plan).toContainText("Accepted");
  await humanInTheLoop.assertAgentReplyVisible(/Done! I've completed that for you/);
});
