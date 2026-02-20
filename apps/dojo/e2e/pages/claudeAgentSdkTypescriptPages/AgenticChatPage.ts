import { Page, Locator, expect } from '@playwright/test';

/**
 * Page object for Claude Agent SDK TypeScript - Agentic Chat feature.
 * Reuses the shared AgenticChatPage pattern for consistency.
 */
export class AgenticChatPage {
  readonly page: Page;
  readonly openChatButton: Locator;
  readonly agentGreeting: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.openChatButton = page.getByRole('button', { name: /chat/i });
    // Use first assistant message as greeting — text varies per feature
    this.agentGreeting = page.locator('.copilotKitAssistantMessage').first();
    this.chatInput = page
      .getByRole('textbox', { name: 'Type a message...' })
      .or(page.getByRole('textbox'))
      .or(page.locator('input[type="text"]'))
      .or(page.locator('textarea'));
    this.sendButton = page
      .locator('[data-test-id="copilot-chat-ready"]')
      .or(page.getByRole('button', { name: /send/i }))
      .or(page.locator('button[type="submit"]'));
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
  }

  async openChat() {
    try {
      await this.openChatButton.click({ timeout: 3000 });
    } catch (error) {
      // Chat might already be open
    }
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);
    try {
      await this.sendButton.click();
    } catch (error) {
      await this.chatInput.press('Enter');
    }
  }

  async assertUserMessageVisible(text: string | RegExp) {
    await expect(this.userMessage.getByText(text)).toBeVisible();
  }

  async assertAgentReplyVisible(expectedText: RegExp | RegExp[]) {
    const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
    for (const expectedText1 of expectedTexts) {
      try {
        const agentMessage = this.page.locator('.copilotKitAssistantMessage', {
          hasText: expectedText1
        });
        await expect(agentMessage.last()).toBeVisible({ timeout: 10000 });
      } catch (error) {
        console.log(`Did not work for ${expectedText1}`)
        // Allow test to pass if at least one expectedText matches
        if (expectedText1 === expectedTexts[expectedTexts.length - 1]) {
          throw error;
        }
      }
    }
  }

  async assertAgentReplyContains(expectedText: string) {
    const agentMessage = this.page.locator('.copilotKitAssistantMessage').last();
    await expect(agentMessage).toContainText(expectedText, { timeout: 10000 });
  }
}
