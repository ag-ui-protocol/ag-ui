import type { Page } from "@playwright/test";
import { expect, test } from "../../test-isolation-helper";
import {
  awaitLLMResponseDone,
  sendChatMessage,
} from "../../utils/copilot-actions";

// `issue_refund` is marked needs_approval, so the SDK pauses the call and the
// run ends with an AG-UI interrupt that useInterrupt renders as Approve /
// Reject. The decision resumes the run: the backend answers the paused call
// from the history, so only an approval runs the refund.

async function requestRefund(page: Page) {
  await page.goto("/openai-agents-python/feature/human_in_the_loop_approval");
  await sendChatMessage(page, "Please refund ORD-1001.");
  await awaitLLMResponseDone(page);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("issue_refund");
  await expect(card).toContainText("ORD-1001");
  return card;
}

test("[OpenAI Agents Python] Approving runs the paused refund tool", async ({
  page,
}) => {
  test.slow();
  const card = await requestRefund(page);

  await page.getByTestId("approve-button").click();
  await awaitLLMResponseDone(page);
  await expect(card).toBeHidden();
  await expect(page.getByText("ORD-1001 has been refunded")).toBeVisible();
});

test("[OpenAI Agents Python] Rejecting skips the paused refund tool", async ({
  page,
}) => {
  test.slow();
  const card = await requestRefund(page);

  await page.getByTestId("reject-button").click();
  await awaitLLMResponseDone(page);
  await expect(card).toBeHidden();
  await expect(page.getByText("ORD-1001 was not refunded")).toBeVisible();
});
