import { Page, Locator, expect } from '@playwright/test';

export class SharedStatePage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentGreeting: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;
  readonly promptResponseLoader: Locator;
  readonly ingredientCards: Locator;
  readonly instructionsContainer: Locator;
  readonly addIngredient: Locator;

  constructor(page: Page) {
    this.page = page;
    // Remove iframe references and use actual greeting text
    this.agentGreeting = page.getByText("Hi 👋 How can I help with your recipe?");
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.promptResponseLoader = page.getByRole('button', { name: 'Please Wait...', disabled: true });
    this.instructionsContainer = page.locator('.instructions-container');
    this.addIngredient = page.getByRole('button', { name: '+ Add Ingredient' });
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
    this.ingredientCards = page.locator('.ingredient-card');
  }

  async openChat() {
    await this.agentGreeting.isVisible();
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);
    await this.sendButton.click();
  }

  async loader() {
    const timeout = (ms) => new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Timeout waiting for promptResponseLoader to become visible")), ms);
    });

    await Promise.race([
      this.promptResponseLoader.isVisible(),
      timeout(5000) // 5 seconds timeout
    ]);
  }

  async awaitIngredientCard(name: string) {
    const selector = `.ingredient-card:has(input.ingredient-name-input[value="${name}"])`;
    const cardLocator = this.page.locator(selector);
    await expect(cardLocator).toBeVisible();
  }

  async addNewIngredient(placeholderText: string) {
      this.addIngredient.click();
      this.page.locator(`input[placeholder="${placeholderText}"]`);
  }

  async getInstructionItems(containerLocator: Locator ) {
    const count = await containerLocator.locator('.instruction-item').count();
    if (count <= 0) {
      throw new Error('No instruction items found in the container.');
    }
    console.log(`✅ Found ${count} instruction items.`);
    return count;
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    await expect(this.agentMessage.getByText(expectedText)).toBeVisible();
  }

  async assertUserMessageVisible(message: string) {
    await expect(this.page.getByText(message)).toBeVisible();
  }
}