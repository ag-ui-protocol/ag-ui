import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test.describe("Mastra - Agentic Chat Reasoning", () => {
  test("should load reasoning page and handle chat interaction", async ({
    page,
  }) => {
    await page.goto("/mastra/feature/agentic_chat_reasoning");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.sendMessage("What is the best car to buy?");
    await chat.assertAgentReplyVisible(
      /Toyota|Honda|Mazda|recommendations/i,
    );
  });

  test("should display model selection dropdown", async ({ page }) => {
    await page.goto("/mastra/feature/agentic_chat_reasoning");

    // The reasoning page has a model dropdown
    const dropdown = page.getByRole("button", {
      name: /OpenAI|Anthropic|Gemini/i,
    });
    await expect(dropdown).toBeVisible();
  });
});
