import { test, expect } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[OpenAI Agents Python] Agentic Chat sends and receives a message", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/agentic_chat");

  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();
  await chat.sendMessage("Hi, I am Abdelrahman");

  await chat.assertUserMessageVisible("Hi, I am Abdelrahman");
  await chat.assertAgentReplyVisible(/Hello/i);
});

test("[OpenAI Agents Python] Agentic Chat retains memory across turns", async ({
  page,
}) => {
  await page.goto("/openai-agents-python/feature/agentic_chat");

  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await expect(chat.agentGreeting).toBeVisible();

  const favFruit = "Mango";
  await chat.sendMessage(`My favorite fruit is ${favFruit}`);
  await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
  await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));

  await chat.sendMessage("Can you remind me what my favorite fruit is?");
  await chat.assertUserMessageVisible(
    "Can you remind me what my favorite fruit is?",
  );
  await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
});
