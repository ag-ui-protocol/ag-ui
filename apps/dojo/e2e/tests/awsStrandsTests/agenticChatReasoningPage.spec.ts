import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Strands] Agentic Chat Reasoning sends and receives a message", async ({
  page,
}) => {
  await page.goto("/aws-strands/feature/agentic_chat_reasoning");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am duaa");

  await chat.assertUserMessageVisible("Hi, I am duaa");
  await chat.assertAgentReplyVisible(/Hello duaa/i);
});
