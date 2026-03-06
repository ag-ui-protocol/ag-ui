import { Page, Locator, expect } from "@playwright/test";

/**
 * Page object for v1 CopilotKit chat UI.
 *
 * V1 uses CSS class selectors (copilotKitInput, copilotKitAssistantMessage, etc.)
 * instead of the data-testid attributes used by v2.
 */
export class V1AgenticChatPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly assistantMessages: Locator;
  readonly userMessages: Locator;

  constructor(page: Page) {
    this.page = page;
    this.chatInput = page.locator(".copilotKitInput textarea");
    this.sendButton = page.locator(
      'button[data-test-id="copilot-chat-ready"], button[data-test-id="copilot-chat-request-in-progress"]'
    );
    this.assistantMessages = page.locator(".copilotKitAssistantMessage");
    this.userMessages = page.locator(".copilotKitUserMessage");
  }

  async waitForReady() {
    await expect(this.chatInput).toBeVisible();
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);

    const sendBtn = this.page.locator(
      'button[data-test-id="copilot-chat-ready"]'
    );
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    // Wait for LLM to finish: in-progress → done
    await this.awaitLLMResponseDone();
  }

  async awaitLLMResponseDone(timeout = 30_000) {
    // Wait for in-progress to start
    try {
      await this.page.waitForFunction(
        () =>
          document.querySelector(
            'button[data-copilotkit-in-progress="true"]'
          ) !== null,
        null,
        { timeout: 5000 }
      );
    } catch {
      // May have already started and finished
    }

    // Wait for in-progress to end
    await this.page.waitForFunction(
      () =>
        document.querySelector(
          'button[data-copilotkit-in-progress="false"]'
        ) !== null ||
        document.querySelector(
          'button[data-test-id="copilot-chat-ready"]'
        ) !== null,
      null,
      { timeout }
    );
  }

  async assertUserMessageVisible(text: string) {
    await expect(this.userMessages.getByText(text)).toBeVisible();
  }

  async assertAgentReplyVisible(pattern: RegExp) {
    const message = this.assistantMessages.filter({ hasText: pattern });
    await expect(message.last()).toBeVisible();
  }
}
