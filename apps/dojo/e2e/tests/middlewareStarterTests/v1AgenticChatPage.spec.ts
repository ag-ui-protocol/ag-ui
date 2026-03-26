import { test } from "../../test-isolation-helper";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";

test("[V1] Middleware Starter sends and receives a message", async ({
  page,
}) => {
  await page.goto("/middleware-starter/feature/v1_agentic_chat");

  const chat = new V1AgenticChatPage(page);
  await chat.sendMessage("Hi");

  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello|Hi|hey|help|assist/i);
});
