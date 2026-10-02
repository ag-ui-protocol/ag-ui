import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { sendChatMessage } from "../../utils/copilot-actions";
import { captureRuntimeSSE, expectRunFinished } from "../../utils/runtime-sse";

const PAGE_URL = "/opencode/feature/interrupt";

test("[OpenCode] permission approval resumes the same turn", async ({
  page,
}) => {
  await page.goto(PAGE_URL);

  const paused = captureRuntimeSSE(page, "opencode", "[permission]");
  await sendChatMessage(page, "Read README.md [permission]");

  const card = page.getByTestId("opencode-interrupt");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Allow read?");
  await expect(card).toContainText("README.md");
  expect(await paused).toContain('"type":"interrupt"');

  const resumed = captureRuntimeSSE(page, "opencode", "resume");
  await card.getByTestId("opencode-allow-once").click();
  expectRunFinished(await resumed, "OpenCode permission resume");
  await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
    "Request response: once. Done.",
  );
});

test("[OpenCode] question answer resumes the same turn", async ({ page }) => {
  await page.goto(PAGE_URL);

  const paused = captureRuntimeSSE(page, "opencode", "[question]");
  await sendChatMessage(page, "Choose a color [question]");

  const card = page.getByTestId("opencode-interrupt");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Which color?");
  expect(await paused).toContain('"type":"interrupt"');

  await card.getByRole("radio", { name: "Blue" }).check();
  const resumed = captureRuntimeSSE(page, "opencode", "resume");
  await card.getByTestId("opencode-answer").click();
  expectRunFinished(await resumed, "OpenCode question resume");
  await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
    "Blue",
  );
});
