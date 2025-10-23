import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Cloudflare] Human in the Loop generates task steps for approval", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/human_in_the_loop");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("Help me plan a website launch");
    await waitForAIResponse(page);

    // Should present steps for user review
    await chat.assertAgentReplyVisible(/step|plan|website/i);
  });
});

test("[Cloudflare] Human in the Loop responds to task requests", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/cloudflare/feature/human_in_the_loop");

    const chat = new AgenticChatPage(page);

    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });

    await chat.sendMessage("I need to organize a team meeting");
    await waitForAIResponse(page);

    const agentMessage = page.locator(".copilotKitAssistantMessage").last();
    await expect(agentMessage).toContainText(/meeting|organize|step/i, {
      timeout: 15000,
    });
  });
});
