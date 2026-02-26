import {
  test,
  expect,
  retryOnAIFailure,
} from "../../test-isolation-helper";
import { AgenticChatPage } from "../../featurePages/AgenticChatPage";
import { sendChatMessage } from "../../utils/copilot-actions";

test("[Server Starter all features] Agentic Chat displays countdown from 10 to 1 with tick mark", async ({
  page,
}) => {
  test.setTimeout(90000);
  await retryOnAIFailure(async () => {
    await page.goto(
      "/server-starter-all-features/feature/agentic_chat"
    );

    const chat = new AgenticChatPage(page);
    await chat.openChat();
    await chat.agentGreeting.waitFor({ state: "visible" });
    // Use sendChatMessage to avoid sendAndAwaitResponse timeout;
    // the countdown assertion below handles the waiting with its own timeout.
    await sendChatMessage(page, "Hey there");
    await chat.assertUserMessageVisible("Hey there");

    // v2 CopilotKit uses data-testid="copilot-assistant-message" with data-message-id
    const countdownMessage = page
      .getByTestId('copilot-assistant-message')
      .filter({ hasText: 'counting down:' });

    await expect(countdownMessage).toBeVisible({ timeout: 30000 });

    // Wait for countdown to complete by checking for the tick mark
    await expect(countdownMessage)
      .toContainText('✓', { timeout: 15000 });

    const countdownText = await countdownMessage.textContent();

    expect(countdownText).toContain("counting down:");
    expect(countdownText).toMatch(/counting down:\s*10\s+9\s+8\s+7\s+6\s+5\s+4\s+3\s+2\s+1\s+✓/);
  });
});