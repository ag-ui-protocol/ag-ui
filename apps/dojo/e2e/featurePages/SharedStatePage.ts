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
    // Wait for the loading indicator to appear (it may already be visible)
    try {
      await this.promptResponseLoader.waitFor({ state: "visible", timeout: 10000 });
    } catch {
      // Loader may have already appeared and disappeared, continue
    }
    // Wait for the loading indicator to disappear (AI response finished)
    try {
      await this.promptResponseLoader.waitFor({ state: "hidden", timeout: 60000 });
    } catch {
      // Loader may already be gone
    }
    // Additional stabilization wait for content to render
    await this.page.waitForTimeout(2000);
  }

  async awaitIngredientCard(name: string) {
    // Use page.waitForFunction for case-insensitive matching on input values,
    // since CSS attribute selectors are case-sensitive
    await this.page.waitForFunction(
      (ingredientName) => {
        const inputs = document.querySelectorAll('.ingredient-card input.ingredient-name-input');
        return Array.from(inputs).some(
          (input: HTMLInputElement) => input.value.toLowerCase().includes(ingredientName.toLowerCase())
        );
      },
      name,
      { timeout: 60000 }
    );
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