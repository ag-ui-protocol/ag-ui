import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test.describe("LangGraph TypeScript - Agentic Chat Multimodal", () => {
  test("should load multimodal page and handle chat interaction", async ({
    page,
  }) => {
    await page.goto("/langgraph-typescript/feature/agentic_chat_multimodal");

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.sendMessage("Can you describe what you see in images?");
    await chat.assertAgentReplyVisible(
      /image|visual|describe|analyze/i,
    );
  });
});
