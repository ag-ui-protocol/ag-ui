import { test } from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[OpenAI Agents JS] Agentic Chat sends and receives a greeting", async ({
  page,
}) => {
  await page.goto("/openai-agents-js/feature/agentic_chat");
  const chat = new AgenticChatPage(page);

  await chat.openChat();
  await chat.sendMessage("Hi");
  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello|Hi|hey/i);
});
