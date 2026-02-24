import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import { sendAndAwaitResponse } from "../utils/copilot-actions";

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
    this.openChatButton = CopilotSelectors.chatToggle(page);
    this.agentGreeting = page
      .getByText("Hi, I'm an agent. Want to chat?");
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.chatBackground = page
      .locator('div[style*="background"]')
      .or(page.locator('.flex.justify-center.items-center.h-full.w-full'))
      .or(page.locator('body'));
    this.agentMessage = CopilotSelectors.assistantMessages(page);
    this.userMessage = CopilotSelectors.userMessages(page);
  }

  async openChat() {
    try {
      await this.openChatButton.click({ timeout: 3000 });
    } catch (error) {
      // Chat might already be open
    }
  }

  async sendMessage(message: string) {
    await sendAndAwaitResponse(this.page, message);
  }

  async getBackground(
    property: "backgroundColor" | "backgroundImage" = "backgroundColor"
  ): Promise<string> {
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

  async assertAgentReplyVisible(expectedText: RegExp | RegExp[]) {
    const expectedTexts = Array.isArray(expectedText) ? expectedText : [expectedText];
    for (const expectedText1 of expectedTexts) {
      try {
        const agentMessage = CopilotSelectors.assistantMessages(this.page).filter({
          hasText: expectedText1
        });
        await expect(agentMessage.last()).toBeVisible();
      } catch (error) {
        console.log(`Did not work for ${expectedText1}`)
        // Allow test to pass if at least one expectedText matches
        if (expectedText1 === expectedTexts[expectedTexts.length - 1]) {
          throw error;
        }
      }
    }
  }

  async assertAgentReplyContains(expectedText: string) {
    const agentMessage = CopilotSelectors.assistantMessages(this.page).last();
    await expect(agentMessage).toContainText(expectedText);
  }

  async getAssistantMessageText(index: number): Promise<string> {
    const message = this.agentMessage.nth(index);
    await expect(message).toBeVisible();
    return (await message.textContent()) ?? "";
  }

  async regenerateResponse(index: number) {
    const message = this.agentMessage.nth(index);
    await expect(message).toBeVisible();

    // Hover over the message to reveal the regenerate button
    await message.hover();

    const regenerateButton = message.getByTestId("copilot-regenerate-button");

    try {
      await regenerateButton.click({ timeout: 3000 });
    } catch {
      // If hover didn't reveal the button, force click
      await regenerateButton.click({ force: true });
    }
  }

  async assertWeatherResponseStructure() {
    const agentMessage = CopilotSelectors.assistantMessages(this.page).last();

    // Check for main weather response structure
    await expect(agentMessage).toContainText(/weather.*islamabad/i);

    // Check for temperature information
    await expect(agentMessage).toContainText("Temperature:");
    // Check for humidity
    await expect(agentMessage).toContainText("Humidity:");

    // Check for wind speed
    await expect(agentMessage).toContainText("Wind Speed:");
    // Check for conditions
    await expect(agentMessage).toContainText("Conditions:");
  }
}
