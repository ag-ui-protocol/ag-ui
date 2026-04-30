import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Agent Spec Wayflow] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await page.goto("/agent-spec-wayflow/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am duaa");

  await chat.assertUserMessageVisible("Hi, I am duaa");
  await chat.assertAgentReplyVisible(/Hello/i);
});
