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
    // Wait for React to render and apply styles
    await this.page.waitForTimeout(2000);

    // Wait for the main container with background style to be present
    await this.page.waitForSelector('.flex.justify-center.items-center.h-full.w-full', {
      state: 'visible',
      timeout: 10000
    });

    // Try to get the background from the main container
    const mainContainer = this.page.locator('.flex.justify-center.items-center.h-full.w-full').first();

    try {
      const backgroundValue = await mainContainer.evaluate((el) => {
        // Get the inline style background value
        const inlineBackground = el.style.background;
        if (inlineBackground && inlineBackground !== '--copilot-kit-background-color') {
          return inlineBackground;
        }

        // Get computed style
        const computedStyle = getComputedStyle(el);
        const computedBackground = computedStyle.background;
        const computedBackgroundColor = computedStyle.backgroundColor;

        // Check if it's a CSS custom property
        if (inlineBackground === '--copilot-kit-background-color') {
          // Try to resolve the CSS custom property
          const customPropValue = computedStyle.getPropertyValue('--copilot-kit-background-color');
          if (customPropValue) {
            return customPropValue;
          }
        }

        // Return computed values
        if (computedBackground && computedBackground !== 'rgba(0, 0, 0, 0)' && computedBackground !== 'transparent') {
          return computedBackground;
        }

        if (computedBackgroundColor && computedBackgroundColor !== 'rgba(0, 0, 0, 0)' && computedBackgroundColor !== 'transparent') {
          return computedBackgroundColor;
        }

        return computedBackground || computedBackgroundColor;
      });

      console.log(`Main container background: ${backgroundValue}`);

      if (backgroundValue && backgroundValue !== 'rgba(0, 0, 0, 0)' && backgroundValue !== 'transparent') {
        return backgroundValue;
      }
    } catch (error) {
      console.log('Error getting background from main container:', error);
    }

    // Fallback: try other selectors
    const selectors = [
      'div[style*="background"]',
      'div[style*="background-color"]',
      '.copilotKitWindow',
      'body'
    ];

    for (const selector of selectors) {
      try {
        const element = this.page.locator(selector).first();
        console.log(`Checking fallback selector: ${selector}`);

        if (await element.isVisible({ timeout: 5000 })) {
          const value = await element.evaluate(
            (el, prop) => {
              const computedStyle = getComputedStyle(el);
              const inlineStyle = el.style[prop as any];

              // Prefer inline style
              if (inlineStyle && inlineStyle !== 'rgba(0, 0, 0, 0)' && inlineStyle !== 'transparent') {
                return inlineStyle;
              }

              // Then computed style
              const computedValue = computedStyle[prop as any];
              return computedValue;
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

    // Final fallback
    const fallbackValue = await this.page.evaluate((prop) => {
      return getComputedStyle(document.body)[prop as any];
    }, property);

    console.log(`[Final Fallback] ${property}: ${fallbackValue}`);
    return fallbackValue;
  }

  async waitForBackgroundChange(expectedBackground?: string, timeout: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const currentBackground = await this.getBackground();

        // If we're looking for a specific background
        if (expectedBackground) {
          if (currentBackground.includes(expectedBackground) ||
              currentBackground === expectedBackground) {
            return;
          }
        } else {
          // Just wait for any non-default background
          if (currentBackground !== 'oklch(1 0 0)' &&
              currentBackground !== 'rgba(0, 0, 0, 0)' &&
              currentBackground !== 'transparent' &&
              !currentBackground.includes('--copilot-kit-background-color')) {
            return;
          }
        }

        await this.page.waitForTimeout(500);
      } catch (error) {
        await this.page.waitForTimeout(500);
      }
    }

    throw new Error(`Background did not change to expected value within ${timeout}ms`);
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
