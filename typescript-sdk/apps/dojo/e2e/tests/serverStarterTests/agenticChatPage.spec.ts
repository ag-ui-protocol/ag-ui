import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

// Skip all tests in this file when CLOUD_AGENTS is set
test.skip(!!process.env.CLOUD_AGENTS, 'Skipping Server Starter tests when CLOUD_AGENTS is set');

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