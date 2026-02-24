import { Page, Locator, expect } from '@playwright/test';
import { CopilotSelectors } from '../utils/copilot-selectors';
import { sendChatMessage, awaitLLMResponseDone } from '../utils/copilot-actions';

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
    this.agentGreeting = page.getByText("Hi 👋 How can I help with your recipe?");
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.promptResponseLoader = page.getByRole('button', { name: 'Please Wait...', disabled: true });
    this.instructionsContainer = page.locator('.instructions-container');
    this.addIngredient = page.getByRole('button', { name: '+ Add Ingredient' });
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
    this.ingredientCards = page.locator('.ingredient-card');
  }

  async openChat() {
    await this.agentGreeting.isVisible();
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
  }

  async loader() {
    // Wait for the LLM stream to finish using data-copilot-running
    await awaitLLMResponseDone(this.page);
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
      { timeout: 15000 }
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
