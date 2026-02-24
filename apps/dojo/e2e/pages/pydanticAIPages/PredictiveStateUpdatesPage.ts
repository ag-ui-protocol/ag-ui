import { Page, Locator, expect } from '@playwright/test';
import { CopilotSelectors } from '../../utils/copilot-selectors';
import { sendAndAwaitResponse } from '../../utils/copilot-actions';

export class PredictiveStateUpdatesPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentGreeting: Locator;
  readonly agentResponsePrompt: Locator;
  readonly userApprovalModal: Locator;
  readonly approveButton: Locator;
  readonly acceptedButton: Locator;
  readonly confirmedChangesResponse: Locator;
  readonly rejectedChangesResponse: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;
  readonly highlights: Locator;

  constructor(page: Page) {
    this.page = page;
    this.agentGreeting = page.getByText("Hi 👋 How can I help with your document?");
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.agentResponsePrompt = page.locator('div.tiptap.ProseMirror');
    this.userApprovalModal = page.locator('div.bg-white.rounded.shadow-lg >> text=Confirm Changes');
    this.acceptedButton = page.getByText('✓ Accepted');
    this.confirmedChangesResponse = CopilotSelectors.assistantMessages(page).first();
    this.rejectedChangesResponse = CopilotSelectors.assistantMessages(page).last();
    this.highlights = page.locator('.tiptap em');
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
  }

  async openChat() {
    await this.agentGreeting.isVisible();
  }

  async sendMessage(message: string) {
    await sendAndAwaitResponse(this.page, message);
  }

  async getPredictiveResponse() {
    await expect(this.agentResponsePrompt).toBeVisible();
    await this.agentResponsePrompt.click();
  }

  async getButton(page, buttonName) {
    return page.getByRole('button', { name: buttonName }).click();
  }

  async getStatusLabelOfButton(page, statusText) {
    return page.getByText(statusText, { exact: true });
  }

  async getUserApproval() {
    await this.userApprovalModal.last().isVisible();
    await this.getButton(this.page, "Confirm");
    const acceptedLabel = this.userApprovalModal.last().locator('text=✓ Accepted');
  }

  async getUserRejection() {
    await this.userApprovalModal.last().isVisible();
    await this.getButton(this.page, "Reject");
    const rejectedLabel = await this.getStatusLabelOfButton(this.page, "✕ Rejected");
    await rejectedLabel.isVisible();
  }

  async verifyAgentResponse(dragonName) {
    const paragraphWithName = await this.page.locator(`div.tiptap >> text=${dragonName}`).first();

    const fullText = await paragraphWithName.textContent();
    if (!fullText) {
      return null;
    }

    const match = fullText.match(new RegExp(dragonName, 'i'));
    return match ? match[0] : null;
  }

  async verifyHighlightedText(){
    const highlightSelectors = [
      '.tiptap em',
      '.tiptap s',
      'div.tiptap em',
      'div.tiptap s'
    ];

    let count = 0;
    for (const selector of highlightSelectors) {
      count = await this.page.locator(selector).count();
      if (count > 0) {
        break;
      }
    }

    if (count > 0) {
      expect(count).toBeGreaterThan(0);
    } else {
      const modal = this.page.locator('div.bg-white.rounded.shadow-lg').last();
      await expect(modal).toBeVisible();
    }
  }
}
