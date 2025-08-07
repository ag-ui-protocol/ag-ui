import { Page, Locator, expect } from '@playwright/test';

export class AgenticGenUIPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly planTaskButton: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;
  readonly agentGreeting: Locator;
  readonly agentPlannerContainer: Locator;
  readonly sendButton: Locator;

  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.planTaskButton = page.getByRole('button', { name: 'Agentic Generative UI' });

    // Update greeting text to match actual content
    this.agentGreeting = page.getByText("Hi, I'm an agent! I can help you with anything you need and will show you progress as I work. What can I do for you?");
    this.chatInput = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.agentMessage = page.locator('.copilotKitAssistantMessage');
    this.userMessage = page.locator('.copilotKitUserMessage');
    // More flexible selector for the planner container
    this.agentPlannerContainer = page.locator('div.bg-gray-100.rounded-lg, div.bg-white.rounded-lg, div[class*="bg-gray"], div[class*="space-y"]').filter({ hasText: /starting|assembling|designing|preparing|conducting|selecting|testing|training|launching|landing/ });
    
    // Loading indicator with animated dots
    this.loadingIndicator = page.locator('.copilotKitAssistantMessage').filter({ has: page.locator('.copilotKitActivityDot') });
  }

  async plan() {
    // Simply check that there's an agent response after the planning request
    await expect(this.agentMessage.last()).toBeVisible({ timeout: 15000 });
    console.log("Agent responded to planning request");
  }

  async openChat() {
    // Check if chat is already open or if we need to click something
    const isGreetingVisible = await this.agentGreeting.isVisible().catch(() => false);
    if (!isGreetingVisible) {
      // Try to find and click any button that opens the chat
      const chatOpenButton = this.page.locator('button').filter({ hasText: /chat|start|begin/ }).first();
      if (await chatOpenButton.isVisible().catch(() => false)) {
        await chatOpenButton.click();
      }
    }
    // Wait for greeting to be visible
    await expect(this.agentGreeting).toBeVisible({ timeout: 10000 });
  }

  async sendMessage(message: string) {
    await this.chatInput.fill(message);
    await this.page.waitForTimeout(2000); // Reduced wait time
  }

  getPlannerButton(name: string | RegExp) {
    return this.page.getByRole('button', { name });
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    // Use last() to get the most recent message
    await expect(this.agentMessage.last().getByText(expectedText)).toBeVisible({ timeout: 15000 });
  }

  async getUserText(textOrRegex) {
    return await this.page.getByText(textOrRegex).isVisible();
  }

  async waitForLoadingToCompleteAndVerifyMessages() {
    try {
      // Wait for loading indicator to appear first
      await expect(this.loadingIndicator).toBeVisible({ timeout: 5000 });
      console.log("Loading indicator appeared");
      
      // Wait for loading indicator to disappear
      await expect(this.loadingIndicator).not.toBeVisible({ timeout: 30000 });
      console.log("Loading indicator disappeared");
      
      // Check that there are exactly llama-index messages total
      const messageCount = await this.page.locator('.copilotKitMessage').count();
      expect(messageCount).toBe(5);
      console.log(`Verified: Found exactly 5 messages (${messageCount})`);
      
    } catch (error) {
      console.log("Loading indicator not found or timeout occurred, checking message count anyway");
      // Fallback: just check message count
      const messageCount = await this.page.locator('.copilotKitMessage').count();
      expect(messageCount).toBe(5);
      console.log(`Verified: Found exactly 5 messages (${messageCount})`);
    }
  }
}