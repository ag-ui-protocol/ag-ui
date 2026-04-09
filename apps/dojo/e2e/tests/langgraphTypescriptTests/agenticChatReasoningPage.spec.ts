import { test, expect } from "../../test-isolation-helper";
import {
  sendChatMessage,
  awaitLLMResponseDone,
  openChat,
} from "../../utils/copilot-actions";
import { CopilotSelectors } from "../../utils/copilot-selectors";

// NOTE: CopilotKit (v1.55.1) does not render reasoning/thinking blocks in the UI.
// These tests verify the reasoning page loads, the model dropdown works, and basic
// chat functions correctly. Actual reasoning-token rendering tests should be added
// once CopilotKit exposes thinking blocks in the DOM.

test.describe("[Integration] LangGraph TypeScript - Agentic Chat Reasoning", () => {
  test("should display model selection dropdown", async ({ page }) => {
    await page.goto("/langgraph-typescript/feature/agentic_chat_reasoning");

    // The reasoning page renders a model-provider dropdown
    const dropdown = page.getByRole("button", {
      name: /OpenAI|Anthropic|Gemini/i,
    });
    await expect(dropdown).toBeVisible({ timeout: 10000 });
  });

  test("should send a message and receive a response", async ({ page }) => {
    await page.goto("/langgraph-typescript/feature/agentic_chat_reasoning");
    await openChat(page);

    await sendChatMessage(page, "What is the best car to buy?");
    await awaitLLMResponseDone(page);

    const lastAssistant = CopilotSelectors.assistantMessages(page).last();
    await expect(lastAssistant).toContainText(
      /Toyota|Honda|Mazda|recommendations/i,
      { timeout: 10000 },
    );
  });

  test("should allow switching models via dropdown", async ({ page }) => {
    await page.goto("/langgraph-typescript/feature/agentic_chat_reasoning");

    const dropdown = page.getByRole("button", {
      name: /OpenAI|Anthropic|Gemini/i,
    });
    await expect(dropdown).toBeVisible({ timeout: 10000 });

    // Click the dropdown to open model options
    await dropdown.click();

    // Verify at least one alternative model option is visible
    const modelOption = page.getByRole("option").or(page.getByRole("menuitem")).or(
      page.locator('[role="listbox"] >> text=/OpenAI|Anthropic|Gemini/i'),
    );
    await expect(modelOption.first()).toBeVisible({ timeout: 5000 });
  });
});
