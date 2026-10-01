import { test, expect } from "../../test-isolation-helper";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

// The page registers generate_task_steps as a frontend (human-in-the-loop)
// tool; AGUIStream forwards it to the agent. The shared aimock fixture keyed on
// "one step with eggs" calls it with three steps.
test("[AG2] Human in the Loop renders the plan and resumes after confirmation", async ({
  page,
}) => {
  await page.goto("/ag2/feature/human_in_the_loop");

  const humanInLoop = new HumanInTheLoopPage(page);

  await humanInLoop.openChat();
  await humanInLoop.sendMessage("Plan a cake with one step with eggs");
  await expect(humanInLoop.plan).toBeVisible();
  await expect(humanInLoop.plan.getByTestId("step-item")).toHaveCount(3);

  await humanInLoop.uncheckItem("Crack eggs into bowl");
  expect(await humanInLoop.isStepItemUnchecked("Crack eggs into bowl")).toBe(
    true,
  );
  await humanInLoop.performStepsAndAwait();
});
