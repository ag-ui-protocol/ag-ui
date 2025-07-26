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

  async assertAgentReplyContains(expectedText: string) {
    const agentMessage = this.page.locator(".copilotKitAssistantMessage").last();
    await expect(agentMessage).toContainText(expectedText, { timeout: 10000 });
  }
}