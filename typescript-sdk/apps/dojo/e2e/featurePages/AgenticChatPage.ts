import { Page, Locator, expect } from "@playwright/test";

export class AgenticChatPage {
  readonly page: Page;
  readonly openChatButton: Locator;
  readonly agentGreeting: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly chatBackground: Locator;
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
    this.chatBackground = page
      .locator('div[style*="background"]')
      .or(page.locator('.flex.justify-center.items-center.h-full.w-full'))
      .or(page.locator('body'));
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

  async getBackground(
    property: "backgroundColor" | "backgroundImage" = "backgroundColor"
  ): Promise<string> {
    // Wait a bit for background to apply
    await this.page.waitForTimeout(500);

    // Try multiple selectors for the background element
    const selectors = [
      'div[style*="background"]',
      'div[style*="background-color"]',
      '.flex.justify-center.items-center.h-full.w-full',
      'div.flex.justify-center.items-center.h-full.w-full',
      '[class*="bg-"]',
      'div[class*="background"]'
    ];

    for (const selector of selectors) {
      try {
        const element = this.page.locator(selector).first();
        if (await element.isVisible({ timeout: 1000 })) {
          const value = await element.evaluate(
            (el, prop) => {
              // Check inline style first
              if (el.style.background) return el.style.background;
              if (el.style.backgroundColor) return el.style.backgroundColor;
              // Then computed style
              return getComputedStyle(el)[prop as any];
            },
            property
          );
          if (value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent") {
            console.log(`[${selector}] ${property}: ${value}`);
            return value;
          }
        }
      } catch (e) {
        continue;
      }
    }

    // Fallback to original element
    const value = await this.chatBackground.first().evaluate(
      (el, prop) => getComputedStyle(el)[prop as any],
      property
    );
    console.log(`[Fallback] ${property}: ${value}`);
    return value;
  }

  async getGradientButtonByName(name: string | RegExp) {
    return this.page.getByRole("button", { name });
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

  async assertWeatherResponseStructure() {
    const agentMessage = this.page.locator(".copilotKitAssistantMessage").last();

    // Check for main weather response structure
    await expect(agentMessage).toContainText("The current weather in Islamabad is as follows:", { timeout: 10000 });

    // Check for temperature information
    await expect(agentMessage).toContainText("Temperature:", { timeout: 5000 });
    // Check for humidity
    await expect(agentMessage).toContainText("Humidity:", { timeout: 5000 });

    // Check for wind speed
    await expect(agentMessage).toContainText("Wind Speed:", { timeout: 5000 });
    // Check for conditions
    await expect(agentMessage).toContainText("Conditions:", { timeout: 5000 });
  }
}
