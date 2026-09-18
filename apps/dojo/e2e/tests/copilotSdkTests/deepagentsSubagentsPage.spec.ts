import { test, expect } from "./test";
import { sendChatMessage, awaitLLMResponseDone } from "../../utils/copilot-actions";
import {
  SUBAGENT_FINAL_ANSWER,
  SUBAGENT_DRAFT_SUMMARY,
  SUBAGENT_REJECTED_REPLY,
  SUPERVISOR_RELAY,
} from "../../deepagents-subagents-fixtures";

// The supervisor delegates via the runtime's built-in `task` tool to a custom
// agent; SDK subagent.* events map 1:1 onto SUBAGENT_*, and the subagent's
// suspended `request_human_approval` surfaces as an interrupt inside its group.
const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

test.describe("Deepagents Subagents Feature", () => {
  test("[GitHub Copilot SDK] groups the subagent's work, approves its answer, and finishes cleanly", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/deepagents_subagents`);
    await sendChatMessage(page, "Why is the sky blue?");

    const group = page.getByTestId("subagent-group").first();
    await expect(group).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("subagent-tag").first()).toBeVisible();

    await expect(page.getByTestId("subagent-hitl").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("subagent-hitl").first()).toContainText(SUBAGENT_DRAFT_SUMMARY);
    await page.getByTestId("subagent-hitl-approve").click();

    await awaitLLMResponseDone(page);
    await expect(page.getByTestId("subagent-done").first()).toBeVisible({ timeout: 30_000 });
    await expect(group).toContainText(SUBAGENT_FINAL_ANSWER);
    await expect(page.getByText(SUPERVISOR_RELAY)).toBeVisible();
    await expect(page.getByTestId("subagent-error")).toHaveCount(0);
    await expect(page.getByTestId("subagent-activity")).toHaveCount(0);
  });

  test("[GitHub Copilot SDK] rejecting the approval produces a different, still-clean finish", async ({
    page,
  }) => {
    await page.goto(`/${integrationId}/feature/deepagents_subagents`);
    await sendChatMessage(page, "Why is the sky blue?");

    await expect(page.getByTestId("subagent-hitl").first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("subagent-hitl-reject").click();

    await awaitLLMResponseDone(page);
    const group = page.getByTestId("subagent-group").first();
    await expect(group).toContainText(SUBAGENT_REJECTED_REPLY, { timeout: 30_000 });
    await expect(group).not.toContainText(SUBAGENT_FINAL_ANSWER);
    await expect(page.getByTestId("subagent-done").first()).toBeVisible();
    await expect(page.getByTestId("subagent-error")).toHaveCount(0);
    await expect(page.getByTestId("subagent-activity")).toHaveCount(0);
  });
});
