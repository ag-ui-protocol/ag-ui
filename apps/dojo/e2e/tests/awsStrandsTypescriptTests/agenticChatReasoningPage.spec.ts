import { test, expect } from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

test.describe("[Integration] AWS Strands (TS) - Agentic Chat Reasoning", () => {
  test("should show reasoning indicator and then the response", async ({
    page,
  }) => {
    await page.goto("/aws-strands-typescript/feature/agentic_chat_reasoning");
    await openChat(page);

    await sendChatMessage(page, "What is the best car to buy?");
    await awaitLLMResponseDone(page);

    const reasoningIndicator = page.getByText(/Thought for/i);
    await expect(reasoningIndicator).toBeVisible({ timeout: 10000 });

    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(
      /Toyota|Honda|Mazda|recommendations|car|vehicle/i,
      { timeout: 10000 },
    );
  });
});
