import { Page, Locator, expect } from '@playwright/test';
import { CopilotSelectors } from '../../utils/copilot-selectors';
import { sendChatMessage, awaitLLMResponseDone } from '../../utils/copilot-actions';

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
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  getPlannerButton(name: string | RegExp) {
    return this.page.getByRole('button', { name });
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.last().getByText(expectedText)).toBeVisible();
  }

  async getUserText(textOrRegex) {
    return await this.page.getByText(textOrRegex).isVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.userMessage.getByText(message)).toBeVisible();
  }
}
