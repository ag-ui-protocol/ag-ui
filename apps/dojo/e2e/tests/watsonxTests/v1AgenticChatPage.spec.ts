import { test } from "../../test-isolation-helper";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";
import { WATSONX_PROMPTS, WATSONX_REPLIES } from "../../watsonx-fixtures";

test("[V1] watsonx sends and receives a message", async ({ page }) => {
  await page.goto("/watsonx/feature/v1_agentic_chat");

  const chat = new V1AgenticChatPage(page);
  await chat.sendMessage(WATSONX_PROMPTS.greeting);

  await chat.assertUserMessageVisible(WATSONX_PROMPTS.greeting);
  await chat.assertAgentReplyVisible(new RegExp(WATSONX_REPLIES.greeting));
});
