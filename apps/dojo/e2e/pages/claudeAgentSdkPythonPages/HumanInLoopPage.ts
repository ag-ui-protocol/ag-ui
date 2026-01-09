import { Page, Locator, expect } from '@playwright/test';

/**
 * Page object for Claude Agent SDK Python - Human in the Loop feature.
 * Follows the established pattern from other integration HumanInLoopPage objects.
 */
export class HumanInLoopPage {
  readonly page: Page;
  readonly planTaskButton: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentGreeting: Locator;
  readonly plan: Locator;
  readonly performStepsButton: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.planTaskButton = page.getByRole('button', { name: 'Human in the loop Plan a task' });
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
    this.plan = page.getByTestId('select-steps');
    this.performStepsButton = page.getByRole('button', { name: 'Confirm' });
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
  }

  async openChat() {
    await this.agentGreeting.isVisible();
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

  async selectItemsInPlanner() {
    await expect(this.plan).toBeVisible({ timeout: 10000 });
    await this.plan.click();
  }

  async uncheckItem(identifier: number | string): Promise<string> {
    const plannerContainer = this.page.getByTestId('select-steps');
    const items = plannerContainer.getByTestId('step-item');

    let item;
    if (typeof identifier === 'number') {
      item = items.nth(identifier);
    } else {
      item = items.filter({
        has: this.page.getByTestId('step-text').filter({ hasText: identifier })
      }).first();
    }
    const stepTextElement = item.getByTestId('step-text');
    const text = await stepTextElement.innerText();
    await item.click();

    return text;
  }

  async isStepItemUnchecked(target: number | string): Promise<boolean> {
    const plannerContainer = this.page.getByTestId('select-steps');
    const items = plannerContainer.getByTestId('step-item');

    let item;
    if (typeof target === 'number') {
      item = items.nth(target);
    } else {
      item = items.filter({
        has: this.page.getByTestId('step-text').filter({ hasText: target })
      }).first();
    }
    const checkbox = item.locator('input[type="checkbox"]');
    return !(await checkbox.isChecked());
  }

  async performSteps() {
    await this.performStepsButton.click();
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.last().getByText(expectedText)).toBeVisible({ timeout: 10000 });
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }
}
