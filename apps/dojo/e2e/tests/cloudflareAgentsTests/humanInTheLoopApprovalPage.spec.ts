import type { Page } from "@playwright/test";
import { expect, test } from "../../test-isolation-helper";
import {
  awaitLLMResponseDone,
  gotoAndAwaitRuntimeInfo,
  sendChatMessage,
} from "../../utils/copilot-actions";

// The Worker's `issue_refund` tool has `needsApproval`, so the AI SDK pauses
// the call and the run ends with an AG-UI interrupt (reason "tool_approval")
// that useInterrupt renders as Approve / Reject. The decision resumes the run
// statelessly: only an approval runs the refund, and the agent's reply differs
// by the tool's outcome.

async function requestRefund(page: Page) {
  await gotoAndAwaitRuntimeInfo(
    page,
    "/cloudflare-agents/feature/human_in_the_loop_approval",
  );
  await sendChatMessage(page, "Please refund ORD-1001.");
  await awaitLLMResponseDone(page);
  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("issue_refund");
  await expect(card).toContainText("ORD-1001");
  return card;
}

test("[Cloudflare Agents] Approving runs the paused refund tool", async ({
  page,
}) => {
  test.slow();
  const card = await requestRefund(page);

  await page.getByTestId("approve-button").click();
  await awaitLLMResponseDone(page);
  await expect(card).toBeHidden();
  await expect(page.getByText("ORD-1001 has been refunded")).toBeVisible();
});

test("[Cloudflare Agents] Rejecting skips the paused refund tool", async ({
  page,
}) => {
  test.slow();
  const card = await requestRefund(page);

  await page.getByTestId("reject-button").click();
  await awaitLLMResponseDone(page);
  await expect(card).toBeHidden();
  await expect(page.getByText("ORD-1001 was not refunded")).toBeVisible();
});
