import { expect, test } from "../../test-isolation-helper";
import { sendAndAwaitResponse } from "../../utils/copilot-actions";

test("[OpenAI Agents Python] Subagents records all specialist delegations", async ({
  page,
}) => {
  test.slow();
  await page.goto("/openai-agents-python/feature/subagents");

  await sendAndAwaitResponse(
    page,
    "Write a short article about the history of AI",
  );

  const log = page.getByText("Delegation log").locator("..");
  await expect(log.getByText("Researcher").last()).toBeVisible();
  await expect(log.getByText("Writer").last()).toBeVisible();
  await expect(log.getByText("Critic").last()).toBeVisible();
  await expect(log.getByText("complete")).toHaveCount(3);
});
