import { Page, Locator, expect } from "@playwright/test";

export class ToolBaseGenUIPage {
  readonly page: Page;
  readonly haikuAgentIntro: Locator;
  readonly messageBox: Locator;
  readonly sendButton: Locator;
  readonly applyButton: Locator;
  readonly haikuBlock: Locator;
  readonly japaneseLines: Locator;
  readonly mainHaikuDisplay: Locator;

  constructor(page: Page) {
    this.page = page;
    this.haikuAgentIntro = page.getByText("I'm a haiku generator 👋. How can I help you?").first();
    this.messageBox = page.getByPlaceholder("Type a message...").first();
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]').first();
    this.haikuBlock = page.locator('[data-testid="haiku-card"]');
    this.applyButton = page.getByRole("button", { name: "Apply" });
    this.japaneseLines = page.locator('[data-testid="haiku-japanese-line"]');
    this.mainHaikuDisplay = page.locator('[data-testid="haiku-carousel"]');
  }

  async generateHaiku(message: string) {
    // Wait for either sidebar or popup to be ready
    await this.page.waitForTimeout(2000);
    await this.messageBox.waitFor({ state: "visible", timeout: 15000 });
    await this.messageBox.click();
    await this.messageBox.fill(message);
    await this.page.waitForTimeout(1000);
    await this.sendButton.waitFor({ state: "visible", timeout: 15000 });
    await this.sendButton.click();
    await this.page.waitForTimeout(2000);
  }

  async checkGeneratedHaiku() {
    await this.page.waitForTimeout(3000);
    const cards = this.page.locator('[data-testid="haiku-card"]');
    await cards.last().waitFor({ state: "visible", timeout: 20000 });
    const mostRecentCard = cards.last();
    await mostRecentCard
      .locator('[data-testid="haiku-japanese-line"]')
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
  }

  async extractChatHaikuContent(page: Page): Promise<string> {
    await page.waitForTimeout(4000);
    const allHaikuCards = page.locator('[data-testid="haiku-card"]');
    await allHaikuCards.first().waitFor({ state: "visible", timeout: 15000 });
    const cardCount = await allHaikuCards.count();
    let chatHaikuContainer;
    let chatHaikuLines;

    for (let cardIndex = cardCount - 1; cardIndex >= 0; cardIndex--) {
      chatHaikuContainer = allHaikuCards.nth(cardIndex);
      chatHaikuLines = chatHaikuContainer.locator('[data-testid="haiku-japanese-line"]');
      const linesCount = await chatHaikuLines.count();

      if (linesCount > 0) {
        try {
          await chatHaikuLines.first().waitFor({ state: "visible", timeout: 8000 });
          break;
        } catch (error) {
          continue;
        }
      }
    }

    if (!chatHaikuLines) {
      throw new Error("No haiku cards with visible lines found");
    }

    const count = await chatHaikuLines.count();
    const lines: string[] = [];

    for (let i = 0; i < count; i++) {
      const haikuLine = chatHaikuLines.nth(i);
      const japaneseText = await haikuLine.innerText();
      lines.push(japaneseText);
    }

    const chatHaikuContent = lines.join("").replace(/\s/g, "");
    return chatHaikuContent;
  }

  async extractMainDisplayHaikuContent(page: Page): Promise<string> {
    const activeCard = page.locator('[data-testid="main-haiku-display"].active').last();

    try {
      await activeCard.waitFor({ state: 'visible', timeout: 5000 });
    } catch (error) {
      // Fallback to any visible haiku lines if the active card isn't available yet
      const fallbackLines = page.locator('[data-testid="main-haiku-line"]');
      const fallbackCount = await fallbackLines.count();
      if (fallbackCount === 0) {
        return '';
      }

      const fallbackLineTexts: string[] = [];
      for (let i = 0; i < fallbackCount; i++) {
        const fallbackLine = fallbackLines.nth(i);
        const japaneseText = await fallbackLine.locator('p').first().innerText();
        fallbackLineTexts.push(japaneseText);
      }

      return fallbackLineTexts.join('').replace(/\s/g, '');
    }

    const mainDisplayLines = activeCard.locator('[data-testid="main-haiku-line"]');
    const count = await mainDisplayLines.count();
    if (count === 0) {
      return '';
    }

    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const haikuLine = mainDisplayLines.nth(i);
      const japaneseText = await haikuLine.locator('p').first().innerText();
      lines.push(japaneseText);
    }

    return lines.join('').replace(/\s/g, '');
  }

  async checkHaikuDisplay(page: Page): Promise<void> {
    const chatHaikuContent = await this.extractChatHaikuContent(page);

    await expect
      .poll(async () => {
        const content = await this.extractMainDisplayHaikuContent(page);
        return content;
      }, {
        timeout: 10000,
        message: 'Main display did not match the latest chat haiku',
      })
      .toBe(chatHaikuContent);
  }
}
