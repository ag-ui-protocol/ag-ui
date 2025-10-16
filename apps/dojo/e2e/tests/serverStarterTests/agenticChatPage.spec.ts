import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Server Starter] Testing Agentic Chat", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/server-starter/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Hello world!/i);
  });
});