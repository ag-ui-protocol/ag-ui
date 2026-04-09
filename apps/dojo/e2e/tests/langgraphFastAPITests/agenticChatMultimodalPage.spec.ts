import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test.describe("LangGraph FastAPI - Agentic Chat Multimodal", () => {
  test("should load multimodal page and handle chat interaction", async ({
    page,
  }) => {
    await page.goto("/langgraph-fastapi/feature/agentic_chat_multimodal");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.sendMessage("Tell me what do you see in this image");
    await chat.assertAgentReplyVisible(
      /image|visual|content/i,
    );
  });
});
