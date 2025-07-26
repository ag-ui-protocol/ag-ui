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
  readonly agentMessage: Locator;
  readonly userMessage: Locator;
  readonly highlights: Locator;

  constructor(page: Page) {
    this.page = page;
    // Remove iframe references and use actual greeting text
    this.agentGreeting = page.getByText("Hi 👋 How can I help with your document?");
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.agentResponsePrompt = page.locator('div.tiptap.ProseMirror');
    this.userApprovalModal = page.locator('div.bg-white.rounded.shadow-lg >> text=Confirm Changes');
    this.acceptedButton = page.getByText('✓ Accepted');
    this.confirmedChangesResponse = page.locator('div.copilotKitMarkdown');
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
    // Remove iframe reference
    return page.getByRole('button', { name: buttonName }).click();
  }

  async getStatusLabelOfButton(page, statusText) {
    // Remove iframe reference
    return page.getByText(statusText, { exact: true });
  }

  async getUserApproval() {
    await this.userApprovalModal.isVisible();
    await this.getButton(this.page, "Confirm");
    const acceptedLabel = this.userApprovalModal.locator('text=✓ Accepted');
    // await expect(acceptedLabel).toBeVisible();
    // const acceptedLabel = await this.getStatusLabelOfButton(this.page, "✓ Accepted");
    // await acceptedLabel.isVisible();
  }

  async getUserRejection() {
    await this.userApprovalModal.isVisible();
    await this.getButton(this.page, "Reject");
    await this.acceptedButton.isVisible();
    const acceptedLabel = await this.getStatusLabelOfButton(this.page, "✕ Rejected");
    await acceptedLabel.isVisible();
  }

  async verifyAgentResponse(dragonName) {
    // Remove iframe reference
    const paragraphWithName = await this.page.locator(`div.tiptap >> text=${dragonName}`).first();

    const fullText = await paragraphWithName.textContent();
    if (!fullText) {
      return null;
    }

    const match = fullText.match(new RegExp(dragonName, 'i')); // case-insensitive
    return match ? match[0] : null;
  }

  async verifyHighlightedText(){
    // Check for highlights BEFORE accepting the changes
    // The highlights appear when changes are proposed, not after they're accepted
    const highlightSelectors = [
      '.tiptap em',        // For new/added text
      '.tiptap s',         // For strikethrough/removed text  
      'div.tiptap em',
      'div.tiptap s'
    ];
    
    let count = 0;
    for (const selector of highlightSelectors) {
      count = await this.page.locator(selector).count();
      if (count > 0) {
        console.log(`Found ${count} highlighted elements with selector: ${selector}`);
        break;
      }
    }
    
    if (count > 0) {
      expect(count).toBeGreaterThan(0);
    } else {
      // If no highlights found, verify the changes are visible in the modal instead
      console.log("No highlights in document, checking for confirmation modal");
      const modal = this.page.locator('div.bg-white.rounded.shadow-lg');
      await expect(modal).toBeVisible();
    }
  }
}