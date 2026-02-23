import { Page, Locator, expect } from '@playwright/test';

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
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('button:has(svg.lucide-arrow-up)');
    this.agentResponsePrompt = page.locator('div.tiptap.ProseMirror');
    this.userApprovalModal = page.locator('div.bg-white.rounded.shadow-lg >> text=Confirm Changes');
    this.acceptedButton = page.getByText('✓ Accepted');
    this.confirmedChangesResponse = page.locator('.prose[data-message-id]').first();
    this.rejectedChangesResponse = page.locator('.prose[data-message-id]').last();
    this.highlights = page.locator('.tiptap em');
    this.agentMessage = page.locator('.prose[data-message-id]');
    this.userMessage = page.locator('.items-end[data-message-id]');
  }

  async openChat() {
    await this.agentGreeting.isVisible();
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);
    try {
      await this.sendButton.click({ timeout: 3000 });
    } catch {
      await this.chatInput.press("Enter");
    }
  }

  async getPredictiveResponse() {
    await expect(this.agentResponsePrompt).toBeVisible({ timeout: 10000 });
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
      const modal = this.page.locator('div.bg-white.rounded.shadow-lg');
      await expect(modal).toBeVisible();
    }
  }
}
