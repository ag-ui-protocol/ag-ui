import { test, expect } from "./test";
import { sendChatMessage, awaitLLMResponseDone, openChat } from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

test("[GitHub Copilot SDK] Agentic Chat Reasoning shows the reasoning indicator and the reply", async ({
  page,
}) => {
  await page.goto(`/${integrationId}/feature/agentic_chat_reasoning`);
  await openChat(page);

  await sendChatMessage(page, "What is the best car to buy?");
  await awaitLLMResponseDone(page);

  await expect(page.getByText(/Thought for/i)).toBeVisible({ timeout: 10_000 });
  await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
    /Toyota|Honda|Mazda|recommendations/i,
    { timeout: 10_000 },
  );
});
