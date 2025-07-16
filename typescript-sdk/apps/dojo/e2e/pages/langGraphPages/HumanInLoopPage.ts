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
    
    // Remove iframe references for new page structure
    this.agentGreeting = page.getByText('This agent demonstrates human-in-the-loop');
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.plan = page.locator("div.bg-gray-100.rounded-lg").last();
    this.performStepsButton = page.getByRole('button', { name: '✨ Perform Steps' });
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
  }

  async openChat() {
    await this.planTaskButton.click();
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
    // Remove iframe reference
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
    
    // Click the label element (this is what toggles the checkbox)
    const label = item.locator('label.flex.items-center.cursor-pointer');
    await label.click();

    return text;
  }

  async isStepItemUnchecked(target: number | string): Promise<boolean> {
    // Remove iframe reference
    const items = this.page.locator('div.text-sm.flex.items-center');

    let item;
    if (typeof target === 'number') {
      item = items.nth(target);
    } else {
      item = items.filter({ hasText: target });
    }

    const span = item.locator('span');
    return await span.evaluate(el => el.classList.contains('line-through'));
  }

  async performSteps() {
    await this.performStepsButton.click();
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.getByText(expectedText)).toBeVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }
}