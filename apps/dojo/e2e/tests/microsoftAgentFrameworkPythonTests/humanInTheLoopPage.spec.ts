import { test, expect } from "../../test-isolation-helper";
import { HumanInTheLoopPage } from "../../featurePages/HumanInTheLoopPage";

test("[MS Agent Framework Python] resumes an approved tool interrupt", async ({
  page,
}) => {
  const humanInLoop = new HumanInTheLoopPage(page);

  await page.goto(
    "/microsoft-agent-framework-python/feature/human_in_the_loop",
  );
  await humanInLoop.openChat();
  await humanInLoop.sendMessage(
    "Plan a mission to Mars with the first step being Start The Planning",
  );

  await expect(humanInLoop.plan).toHaveCount(1);
  await expect(humanInLoop.plan).toBeVisible();
  await humanInLoop.performSteps();
  await expect(
    page.getByText("Done! I've completed that for you."),
  ).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toHaveCount(0);
});
