import { test, expect } from '@playwright/test';

test('responds to user message', async ({ page }) => {
  await page.goto('http://localhost:9999/adk-middleware/feature/agentic_chat');

  // 1. Wait for the page to be fully ready by ensuring the initial message is visible.
  await expect(page.getByText("Hi, I'm an agent. Want to chat?")).toBeVisible({ timeout: 10000 });

  // 2. Interact with the page to send the message.
  const textarea = page.getByPlaceholder('Type a message...');
  await textarea.fill('How many sides are in a square? Please answer in one word. Do not use any punctuation, just the number in word form.');
  await page.keyboard.press('Enter');

  // 3. Assert the final state with a generous timeout.
  //    This is the most important part. We target the *second* assistant message
  //    and wait for it to contain the text "Four". Playwright handles all the waiting.
  const finalResponse = page.locator('.copilotKitMessage.copilotKitAssistantMessage').nth(1);
  await expect(finalResponse).toContainText(/four/i, { timeout: 15000 });

  // 4. (Optional) For added certainty, verify the total message count.
  //    This confirms there are exactly 3 messages: greeting, user query, and agent response.
  await expect(page.locator('.copilotKitMessage')).toHaveCount(3);
});