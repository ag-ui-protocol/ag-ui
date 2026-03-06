import { Page, Locator, expect } from '@playwright/test';
import { CopilotSelectors } from '../utils/copilot-selectors';
import { sendChatMessage, awaitLLMResponseDone } from '../utils/copilot-actions';
import { DEFAULT_WELCOME_MESSAGE } from '../lib/constants';

export class HumanInTheLoopPage {
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
    this.agentGreeting = page.getByText(DEFAULT_WELCOME_MESSAGE);
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.plan = page.getByTestId('select-steps');
    this.performStepsButton = page.getByRole('button', { name: 'Confirm' });
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
  }

  async openChat() {
    await expect(this.agentGreeting).toBeVisible();
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  async selectItemsInPlanner() {
    await expect(this.plan).toBeVisible();
    await this.plan.click();
  }

  async getPlannerOnClick(name: string | RegExp) {
    return this.page.getByRole('button', { name });
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
    await this.performStepsButton.waitFor({ state: "hidden" });
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.last().getByText(expectedText)).toBeVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }
}
