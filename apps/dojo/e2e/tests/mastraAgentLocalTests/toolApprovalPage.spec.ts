import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { awaitResponseAfterAction } from "../../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

// Native tool approval for Mastra: `record_expense` sets `requireApproval`, so
// Mastra pauses the call before it runs. The @ag-ui/mastra bridge surfaces the
// pending approval as an interrupt, CopilotKit's v2 `useInterrupt` renders
// Approve / Reject, and the decision is handed back to Mastra's own
// approveToolCall / declineToolCall for the original call.
//
// The approval gate, the pending call in Mastra storage, and the tool execution
// are real, so the recorded expense id on the tool card can only come from the
// tool actually running. Runs on aimock and on a real model, so model-written
// text (tool args, follow-up replies) is matched by meaning, not exact wording.

async function requestExpense(page: Page) {
  await page.goto("/mastra-agent-local/feature/tool_approval");
  await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

  await CopilotSelectors.chatTextarea(page).fill(
    "Record a $250 expense for the team dinner.",
  );
  await CopilotSelectors.sendButton(page).click();

  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId("approval-approve")).toBeVisible();
  await expect(card.getByTestId("approval-reject")).toBeVisible();
  await expect(card.getByTestId("approval-args")).toContainText("$250");
  await expect(card.getByTestId("approval-args")).toContainText(/team dinner/i);
  return card;
}

// Clicks a decision and waits for the resumed run, including the agent's
// follow-up, to finish.
async function decide(page: Page, card: Locator, testId: string) {
  await awaitResponseAfterAction(page, () => card.getByTestId(testId).click());
  await expect(card).toBeHidden();
}

// The agent's reply after the tool ran: the last assistant message, which must
// be a text reply rather than the message carrying the tool card.
function followUp(page: Page, toolCardTestId: string) {
  return CopilotSelectors.assistantMessages(page)
    .last()
    .filter({ hasNot: page.getByTestId(toolCardTestId) });
}

test.describe("Tool Approval Feature", () => {
  // Real-model runs take two model turns plus the approval round trip.
  test.describe.configure({ timeout: 120_000 });

  test("[Mastra Agent Local] pauses the tool and renders approval controls", async ({
    page,
  }) => {
    await requestExpense(page);

    // Nothing has run yet: no tool result while the approval is pending.
    await expect(page.getByTestId("expense-recorded")).toHaveCount(0);
    await expect(page.getByTestId("expense-declined")).toHaveCount(0);
  });

  test("[Mastra Agent Local] approving runs the original call and the agent follows up", async ({
    page,
  }) => {
    const card = await requestExpense(page);
    await decide(page, card, "approval-approve");

    const recorded = page.getByTestId("expense-recorded");
    await expect(recorded).toHaveCount(1);
    await expect(recorded).toBeVisible();
    await expect(recorded.getByTestId("expense-id")).toHaveText("EXP-25000");
    await expect(recorded).toContainText(/team dinner/i);
    await expect(page.getByTestId("expense-declined")).toHaveCount(0);

    await expect(followUp(page, "expense-recorded")).toContainText("EXP-25000");
  });

  test("[Mastra Agent Local] rejecting declines the call without running it", async ({
    page,
  }) => {
    const card = await requestExpense(page);
    await decide(page, card, "approval-reject");

    const declined = page.getByTestId("expense-declined");
    await expect(declined).toHaveCount(1);
    await expect(declined).toBeVisible();
    await expect(declined).toContainText("not approved");
    await expect(page.getByTestId("expense-recorded")).toHaveCount(0);

    await expect(followUp(page, "expense-declined")).toContainText(
      /not (been )?recorded|not approved/i,
    );
  });
});
