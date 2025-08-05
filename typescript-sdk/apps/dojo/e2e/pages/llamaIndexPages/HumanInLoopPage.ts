import { Page, Locator, expect } from '@playwright/test';

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
    
    // Update greeting text to match actual content from LlamaIndex
    this.agentGreeting = page.getByText("Hi, I'm an agent specialized in helping you with your tasks. How can I help you?");
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.plan = page.locator("div.bg-gray-100.rounded-lg").last();
    // Update button name to match actual DOM
    this.performStepsButton = page.getByRole('button', { name: 'Confirm' });
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
  }

  async openChat() {
    // Chat is already open, just wait for it to be ready
    await this.agentGreeting.isVisible();
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);
    await this.sendButton.click();
  }

  async selectItemsInPlanner() {
    await expect(this.plan).toBeVisible({ timeout: 10000 });
    await this.plan.click();
  }

  async getPlannerOnClick(name: string | RegExp) {
    return this.page.getByRole('button', { name });
  }

  async uncheckItem(identifier: number | string): Promise<string> {
    // Use the last planner (most recent one)
    const plannerContainer = this.page.locator("div.bg-gray-100.rounded-lg").last();
    const items = plannerContainer.locator('div.text-sm.flex.items-center');

    let item;
    if (typeof identifier === 'number') {
      item = items.nth(identifier);
    } else {
      item = items.filter({ hasText: identifier }).first();
    }

    const text = await item.innerText();
    
    // Click the checkbox directly since they have checked="" attributes
    const checkbox = item.locator('input[type="checkbox"]');
    await checkbox.click();

    return text;
  }

  async isStepItemUnchecked(target: number | string): Promise<boolean> {
    const items = this.page.locator('div.text-sm.flex.items-center');

    let item;
    if (typeof target === 'number') {
      item = items.nth(target);
    } else {
      item = items.filter({ hasText: target });
    }

    const checkbox = item.locator('input[type="checkbox"]');
    return !(await checkbox.isChecked());
  }

  async performSteps() {
    await this.performStepsButton.click();
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    // Use last() to get the most recent message and avoid strict mode violations
    await expect(this.agentMessage.last().getByText(expectedText)).toBeVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }
}