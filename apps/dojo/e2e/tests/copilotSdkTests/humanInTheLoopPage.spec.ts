import { test, expect } from "./test";
import { awaitLLMResponseDone } from "../../utils/copilot-actions";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

// `generate_task_steps` is a frontend tool: the runtime suspends the call, the
// run finishes, the browser renders the plan, and "Perform Steps" resolves the
// ORIGINAL pending call on the next run (no re-prompting).
test("[GitHub Copilot SDK] Human in the Loop plans, lets the user edit, and performs steps", async ({
  page,
}) => {
  test.slow();
  const humanInLoop = new HumanInTheLoopPage(page);
  await page.goto(`/${integrationId}/feature/human_in_the_loop`);
  await humanInLoop.openChat();
  await humanInLoop.sendMessage("Hi");
  await humanInLoop.sendMessage(
    "Give me a plan to make brownies, there should be only one step with eggs and one step with oven, this is a strict requirement so adhere",
  );
  await expect(humanInLoop.plan).toBeVisible();
  await humanInLoop.uncheckItem("eggs");
  await humanInLoop.performSteps();
  await awaitLLMResponseDone(page);
  await humanInLoop.sendMessage(
    "Does the planner include eggs? ⚠️ Reply with only words 'Yes' or 'No' (no explanation, no punctuation).",
  );
});
