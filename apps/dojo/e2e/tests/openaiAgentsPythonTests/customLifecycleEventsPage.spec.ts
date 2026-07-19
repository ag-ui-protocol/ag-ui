import { expect, test } from "../../test-isolation-helper";
import { sendAndAwaitResponse } from "../../utils/copilot-actions";

test("[OpenAI Agents Python] Custom Lifecycle Events displays real token usage", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/custom_lifecycle_events");

  await sendAndAwaitResponse(page, "Hi");

  const usage = page.getByLabel("Run usage").last();
  await expect(usage).toBeVisible();
  await expect(usage).toContainText(/\d+ input tokens/);
  await expect(usage).toContainText(/\d+ output tokens/);
});
