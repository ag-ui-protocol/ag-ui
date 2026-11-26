import {
  allowProtocolEvidenceGap,
  expect,
  test,
} from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  gotoAndAwaitRuntimeInfo,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

const PAGE_URL = "/cloudflare-agents/feature/agentic_chat_reasoning";

// The thinker agent runs a reasoning model on the OpenAI Responses API with
// reasoning summaries on; the page's model dropdown just writes state.model,
// which the agent ignores.
test.describe("[Cloudflare Agents] Agentic Chat Reasoning", () => {
  test("[Cloudflare Agents] should display model selection dropdown", async ({
    page,
  }) => {
    allowProtocolEvidenceGap(
      "no-run",
      "only checks that the model picker renders",
    );
    await page.goto(PAGE_URL);

    const dropdown = page.getByRole("button", {
      name: /OpenAI|Anthropic|Gemini/i,
    });
    await expect(dropdown).toBeVisible({ timeout: 10000 });
  });

  test("[Cloudflare Agents] should show reasoning indicator and then the response", async ({
    page,
  }) => {
    await gotoAndAwaitRuntimeInfo(page, PAGE_URL);
    await openChat(page);

    await sendChatMessage(page, "What is the best car to buy?");
    await awaitLLMResponseDone(page);

    // The reasoning UI renders "Thought for Xs" after reasoning completes
    const reasoningIndicator = page.getByText(/Thought for/i);
    await expect(reasoningIndicator).toBeVisible({ timeout: 10000 });

    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(
      /Toyota|Honda|Mazda|recommendations/i,
      { timeout: 10000 },
    );
  });
});
