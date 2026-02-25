import { Page, Locator, expect } from '@playwright/test';
import { CopilotSelectors } from '../../utils/copilot-selectors';
import { sendAndAwaitResponse } from '../../utils/copilot-actions';

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
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
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
    await this.planTaskButton.waitFor({ state: "visible" });
  }

  async sendMessage(message: string) {
    await sendAndAwaitResponse(this.page, message);
  }

  getPlannerButton(name: string | RegExp) {
    return this.page.getByRole('button', { name });
  }

  async assertAgentReplyVisible(expectedText: RegExp | RegExp[]) {
    const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
    let lastError: unknown = null;
    for (const pattern of expectedTexts) {
      try {
        const agentMessage = CopilotSelectors.assistantMessages(this.page).filter({
          hasText: pattern
        });
        await expect(agentMessage.last()).toBeVisible();
        return; // At least one pattern matched, succeed
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError; // No pattern matched
  }

  async getUserText(textOrRegex) {
    return await this.page.getByText(textOrRegex).isVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.userMessage.getByText(message)).toBeVisible();
  }
}
