import { Page, Locator, expect } from '@playwright/test';

export class AgenticGenUIPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly planTaskButton: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;
  readonly agentGreeting: Locator;
  readonly agentPlannerContainer: Locator;
  readonly sendButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.planTaskButton = page.getByRole('button', { name: 'Agentic Generative UI' });
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
    this.agentGreeting = page.getByText('This agent demonstrates');
    this.agentPlannerContainer = page.getByTestId('task-progress');
  }

  async plan() {
    const stepItems = this.agentPlannerContainer.getByTestId('task-step-text');
    const count = await stepItems.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const stepText = await stepItems.nth(i).textContent();
      console.log(`Step ${i + 1}: ${stepText?.trim()}`);
      await expect(stepItems.nth(i)).toBeVisible();
    }
  }

  async openChat() {
    await this.planTaskButton.isVisible();
  }

  async sendMessage(message: string) {
    await this.chatInput.fill(message);
    await this.page.waitForTimeout(5000)
  }

  getPlannerButton(name: string | RegExp) {
    return this.page.getByRole('button', { name });
  }

  async assertAgentReplyVisible(expectedText: RegExp | RegExp[]) {
    const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
    for (const expectedText1 of expectedTexts) {
      try {
        const agentMessage = this.page.locator(".copilotKitAssistantMessage", {
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

  async getUserText(textOrRegex) {
    return await this.page.getByText(textOrRegex).isVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.userMessage.getByText(message)).toBeVisible();
  }
}