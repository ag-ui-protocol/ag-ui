import { test } from "../../test-isolation-helper";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";

test("[V1] Google ADK sends and receives a message", async ({ page }) => {
  await page.goto("/adk-middleware/feature/v1_agentic_chat");

  const chat = new V1AgenticChatPage(page);
  await chat.sendMessage("Hi");

  await chat.assertUserMessageVisible("Hi");
  await chat.assertAgentReplyVisible(/Hello! How can I assist you today\?/);
});
