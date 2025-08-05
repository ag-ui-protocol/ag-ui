import { test, expect } from '@playwright/test';

test('renders initial message', async ({ page }) => {
  await page.goto('http://localhost:9999/langgraph/feature/agentic_chat');

  await expect(page.getByText('Hi, I\'m an agent. Want to chat?')).toBeVisible();
});

test('responds to user message', async ({ page }) => {
  await page.goto('http://localhost:9999/langgraph/feature/agentic_chat');

  const textarea = page.getByPlaceholder('Type a message...');
  textarea.fill('How many sides are in a square? Please answer in one word. Do not use any punctuation, just the number in word form.');
  await page.keyboard.press('Enter');

  page.locator('.copilotKitInputControls button.copilotKitInputControlButton').click();

  await expect(page.locator('.copilotKitMessage')).toHaveCount(3);
  await expect(page.locator('.copilotKitMessage.copilotKitAssistantMessage')).toHaveCount(2);
  await expect(page.locator('.copilotKitMessage.copilotKitUserMessage')).toHaveCount(1);
  await expect(page.locator('.copilotKitMessage.copilotKitAssistantMessage').last()).toHaveText('four', { ignoreCase: true });
});