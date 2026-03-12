import { test } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Claude Agent SDK TypeScript] Agentic Chat sends and receives a greeting message", async ({
  page,
}) => {
  await page.goto("/claude-agent-sdk-typescript/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hi");
  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
});

test("[Claude Agent SDK TypeScript] Agentic Chat retains memory of previous questions", async ({
  page,
}) => {
  test.slow();
  await page.goto("/claude-agent-sdk-typescript/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hi, my name is Alex");
  await chat.assertUserMessageVisible("Hi, my name is Alex");
  await chat.assertAgentReplyVisible(/Hello|Hi|Alex/i);
  await chat.sendMessage("What is my name?");
  await chat.assertUserMessageVisible("What is my name?");
  await chat.assertAgentReplyVisible(/Alex/i);
});

test("[Claude Agent SDK TypeScript] Agentic Chat retains memory of user messages during a conversation", async ({
  page,
}) => {
  test.slow();
  await page.goto("/claude-agent-sdk-typescript/feature/agentic_chat");
  const chat = new AgenticChatPage(page);
  await chat.openChat();
  await chat.sendMessage("Hey there");
  await chat.assertUserMessageVisible("Hey there");
  const favFruit = "Mango";
  await chat.sendMessage(`My favorite fruit is ${favFruit}`);
  await chat.assertUserMessageVisible(`My favorite fruit is ${favFruit}`);
  await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
  await chat.sendMessage("and I love listening to Kaavish");
  await chat.assertUserMessageVisible("and I love listening to Kaavish");
  await chat.assertAgentReplyVisible(/Kaavish/i);
  await chat.sendMessage("tell me an interesting fact about Moon");
  await chat.assertUserMessageVisible("tell me an interesting fact about Moon");
  await chat.assertAgentReplyVisible(/Moon/i);
  await chat.sendMessage("Can you remind me what my favorite fruit is?");
  await chat.assertUserMessageVisible("Can you remind me what my favorite fruit is?");
  await chat.assertAgentReplyVisible(new RegExp(favFruit, "i"));
});
