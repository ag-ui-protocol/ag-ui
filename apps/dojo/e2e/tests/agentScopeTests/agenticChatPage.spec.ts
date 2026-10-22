import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[AgentScope] streams chat and accepts a second turn", async ({
  page,
}) => {
  await page.goto("/agentscope/feature/agentic_chat", {
    waitUntil: "domcontentloaded",
  });
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am Alex");
  await chat.assertUserMessageVisible("Hi, I am Alex");
  await chat.assertAgentReplyVisible(/Hello/i);
  await chat.sendMessage("Hello again");
  await chat.assertUserMessageVisible("Hello again");
  await chat.assertAgentReplyVisible(/Hello/i);
});
