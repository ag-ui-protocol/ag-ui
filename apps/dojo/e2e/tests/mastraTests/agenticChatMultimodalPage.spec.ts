import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test.describe("Mastra - Agentic Chat Multimodal", () => {
  test("should load multimodal page and handle chat interaction", async ({
    page,
  }) => {
    await page.goto("/mastra/feature/agentic_chat_multimodal");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.sendMessage("Tell me what do you see in this image");
    await chat.assertAgentReplyVisible(
      /image|visual|content/i,
    );
  });
});
