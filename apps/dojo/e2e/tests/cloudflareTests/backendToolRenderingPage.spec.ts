import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Cloudflare] Backend Tool Rendering responds to queries", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/backend_tool_rendering");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("Hello");
    await waitForAIResponse(page);

    await chat.assertAgentReplyVisible(/hello|hi|hey/i);
  });
});

test("[Cloudflare] Backend Tool Rendering handles tool calls", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/backend_tool_rendering");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("Can you help me with information?");
    await waitForAIResponse(page);

    const agentMessage = page.locator(".copilotKitAssistantMessage").last();
    await expect(agentMessage).toBeVisible({ timeout: 15000 });
  });
});
