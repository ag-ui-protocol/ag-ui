import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../pages/middlewareStarterPages/AgenticChatPage";

test("[Middleware Starter] Testing Agentic Chat", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/middleware-starter/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await waitForAIResponse(page);
    await chat.assertAgentReplyVisible(/Hello world!/i);
  });
});