import { test, retryOnAIFailure } from "../../test-isolation-helper";
import { V1AgenticChatPage } from "../../featurePages/V1AgenticChatPage";

test("[V1] Mastra sends and receives a message", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/mastra/feature/v1_agentic_chat");

    const chat = new V1AgenticChatPage(page);
    await chat.sendMessage("Hi");

    await chat.assertUserMessageVisible("Hi");
    await chat.assertAgentReplyVisible(/Hello|Hi|hey|help|assist/i);
  });
});
