import {
  test,
  expect,
  waitForAIResponse,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";

test("[Server Starter all features] Agentic Chat displays countdown from 10 to 1 with tick mark", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto(
      "/server-starter-all-features/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    await chat.sendMessage("Hey there");
    await chat.assertUserMessageVisible("Hey there");
    await waitForAIResponse(page);

    const countdownMessage = page
      .locator('.copilotKitAssistantMessage')
      .filter({ hasText: 'counting down:' });

    await expect(countdownMessage).toBeVisible({ timeout: 30000 });

    // Wait for countdown to complete by checking for the tick mark
    await expect(countdownMessage.locator('.copilotKitMarkdownElement'))
      .toContainText('✓', { timeout: 15000 });

    const countdownText = await countdownMessage
      .locator('.copilotKitMarkdownElement')
      .textContent();

    expect(countdownText).toContain("counting down:");
    expect(countdownText).toMatch(/counting down:\s*10\s+9\s+8\s+7\s+6\s+5\s+4\s+3\s+2\s+1\s+✓/);
  });
});