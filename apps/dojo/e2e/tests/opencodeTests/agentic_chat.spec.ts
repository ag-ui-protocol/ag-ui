import { test } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[OpenCode] streams two turns on the same conversation", async ({
  page,
}) => {
  await page.goto("/opencode/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("What is the capital of France?");
  await chat.assertAgentReplyVisible(/capital of France is Paris/i);
  await chat.sendMessage("What did we discuss in the previous turn?");
  await chat.assertAgentReplyVisible(/We discussed Paris/i);
});
