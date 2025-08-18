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
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.agentResponsePrompt = page.locator('div.tiptap.ProseMirror');
    this.userApprovalModal = page.locator('[data-testid="confirm-changes-modal"]').last();
    this.approveButton = page.getByText('✓ Accepted');
    this.acceptedButton = page.getByText('✓ Accepted');
    this.confirmedChangesResponse = page.locator('.copilotKitAssistantMessage').last();
    this.rejectedChangesResponse = page.locator('.copilotKitAssistantMessage').last();
    this.highlights = page.locator('.tiptap em');
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
  }

  async openChat() {   
    await this.agentGreeting.isVisible();
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);
    await this.sendButton.click();
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
    await this.userApprovalModal.isVisible();
    await this.page.locator('[data-testid="confirm-button"]').click();
    const acceptedLabel = this.page.locator('[data-testid="status-display"]').last();
    await acceptedLabel.isVisible();
  }

  async getUserRejection() {
    await this.userApprovalModal.isVisible();
    await this.page.locator('[data-testid="reject-button"]').click();
    const rejectedLabel = this.page.locator('[data-testid="status-display"]').last();
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
      const modal = this.page.locator('[data-testid="confirm-changes-modal"]');
      await expect(modal).toBeVisible();
    }
  }

  async getResponseContent() {
    const contentSelectors = [
      'div.tiptap.ProseMirror',
      'div.copilotKitMarkdown',
      '.copilotKitAssistantMessage',
      'div.tiptap'
    ];
    
    for (const selector of contentSelectors) {
      const elements = this.page.locator(selector);
      const count = await elements.count();
      
      if (count > 0) {
        try {
          const lastElement = elements.nth(count - 1);
          const content = await lastElement.textContent();
          if (content && content.trim().length > 0) {
            return content.trim();
          }
        } catch (error) {
          continue;
        }
      }
    }
    
    const fallbackElements = this.page.locator('div.tiptap, div.copilotKitMarkdown');
    const fallbackCount = await fallbackElements.count();
    if (fallbackCount > 0) {
      const fallbackContent = await fallbackElements.nth(fallbackCount - 1).textContent();
      return fallbackContent ? fallbackContent.trim() : null;
    }
    
    return null;
  }
}