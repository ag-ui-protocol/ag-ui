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
      'button[data-test-id="copilot-chat-ready"], button[data-test-id="copilot-chat-request-in-progress"]',
    );
    this.assistantMessages = page.locator(".copilotKitAssistantMessage");
    this.userMessages = page.locator(".copilotKitUserMessage");
  }

  async openWithAgentConnection(url: string, runtimePath: string) {
    // Register before navigation: the initial connection may finish before the
    // chat becomes visible. A visible input can still belong to a temporary
    // agent while runtime discovery is pending.
    const connected = this.page.waitForResponse(
      async (response) => {
        const request = response.request();
        if (
          new URL(response.url()).pathname !== runtimePath ||
          request.method() !== "POST" ||
          request.postDataJSON()?.method !== "agent/connect"
        ) {
          return false;
        }
        expect(response.ok(), "Initial agent connection must succeed").toBe(
          true,
        );
        // Predicates run concurrently for each response, so an aborted first
        // connection cannot hide a replacement that completes successfully.
        return (await response.finished()) === null;
      },
      { timeout: 30_000 },
    );
    await Promise.all([this.page.goto(url), connected]);
  }

  async waitForReady() {
    await expect(this.chatInput).toBeVisible();
  }

  async sendMessage(message: string) {
    await this.chatInput.click();
    await this.chatInput.fill(message);

    const sendBtn = this.page.locator(
      'button[data-test-id="copilot-chat-ready"]',
    );
    await expect(sendBtn).toBeEnabled();
    const assistantCountBefore = await this.assistantMessages.count();
    // The button can switch from Send to Stop while initial agent connection
    // finishes. Enter is send-only: the V1 input ignores it while busy.
    // Retry only while the original text is still unsent; send clears it.
    await expect
      .poll(
        async () => {
          if ((await this.chatInput.inputValue()) === message) {
            await this.chatInput.press("Enter");
          }
          return this.chatInput.inputValue();
        },
        { timeout: 30_000 },
      )
      .toBe("");

    // The initial greeting and an idle button can both remain visible before
    // the submitted run starts. Require a new reply before checking completion.
    await expect
      .poll(() => this.assistantMessages.count(), { timeout: 30_000 })
      .toBeGreaterThan(assistantCountBefore);
    await this.awaitLLMResponseDone();
  }

  async awaitLLMResponseDone(timeout = 30_000) {
    // Wait for in-progress to start
    try {
      await this.page.waitForFunction(
        () =>
          document.querySelector(
            'button[data-copilotkit-in-progress="true"]',
          ) !== null,
        null,
        { timeout: 5000 },
      );
    } catch {
      // May have already started and finished
    }

    // Wait for in-progress to end
    await this.page.waitForFunction(
      () =>
        document.querySelector(
          'button[data-copilotkit-in-progress="false"]',
        ) !== null ||
        document.querySelector('button[data-test-id="copilot-chat-ready"]') !==
          null,
      null,
      { timeout },
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
