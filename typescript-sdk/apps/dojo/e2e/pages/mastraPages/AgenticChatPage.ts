import { Page, Locator, expect } from "@playwright/test";

export class AgenticChatPage {
  readonly page: Page;
  readonly openChatButton: Locator;
  readonly agentGreeting: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly agentMessage: Locator;
  readonly userMessage: Locator;

  constructor(page: Page) {
    this.page = page;
    this.openChatButton = page.getByRole("button", {
      name: /chat/i,
    });
    this.agentGreeting = page
      .getByText("Hi, I'm an agent. Want to chat?");
    this.chatInput = page
      .getByRole("textbox", { name: "Type a message..." })
      .or(page.getByRole("textbox"))
      .or(page.locator('input[type="text"]'))
      .or(page.locator('textarea'));
    this.sendButton = page
      .locator('[data-test-id="copilot-chat-ready"]')
      .or(page.getByRole("button", { name: /send/i }))
      .or(page.locator('button[type="submit"]'));
    this.agentMessage = page
      .locator(".copilotKitAssistantMessage");
    this.userMessage = page
      .locator(".copilotKitUserMessage");
  }

  async openChat() {
    try {
      await this.openChatButton.click({ timeout: 3000 });
    } catch (error) {
      // Chat might already be open
    }
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);
    try {
      await this.sendButton.click();
    } catch (error) {
      await this.chatInput.press("Enter");
    }
  }

  async assertUserMessageVisible(text: string | RegExp) {
    await expect(this.userMessage.getByText(text)).toBeVisible();
  }

  async assertAgentReplyVisible(expectedText: RegExp) {
    const agentMessage = this.page.locator(".copilotKitAssistantMessage", {
      hasText: expectedText,
    });
    await expect(agentMessage.last()).toBeVisible({ timeout: 10000 });
  }

  async assertWeatherResponseStructure() {
    const agentMessage = this.page.locator(".copilotKitAssistantMessage").last();
    
    // Check for main weather response structure
    await expect(agentMessage).toContainText("The current weather in Islamabad is as follows:", { timeout: 10000 });
    
    // Check for temperature information
    await expect(agentMessage).toContainText("Temperature:", { timeout: 5000 });
    await expect(agentMessage).toContainText("°C", { timeout: 5000 });
    await expect(agentMessage).toContainText("Feels like", { timeout: 5000 });
    
    // Check for humidity
    await expect(agentMessage).toContainText("Humidity:", { timeout: 5000 });
    await expect(agentMessage).toContainText("%", { timeout: 5000 });
    
    // Check for wind speed
    await expect(agentMessage).toContainText("Wind Speed:", { timeout: 5000 });
    await expect(agentMessage).toContainText("km/h", { timeout: 5000 });
    
    // Check for wind gusts
    await expect(agentMessage).toContainText("Wind Gusts:", { timeout: 5000 });
    
    // Check for conditions
    await expect(agentMessage).toContainText("Conditions:", { timeout: 5000 });
  }
}