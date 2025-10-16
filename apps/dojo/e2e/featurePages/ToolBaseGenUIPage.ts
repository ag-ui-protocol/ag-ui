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
    await page.waitForTimeout(2000);
    const carousel = page.locator('[data-testid="haiku-carousel"]');
    await carousel.waitFor({ state: "visible", timeout: 10000 });

    // Find the visible carousel item (the active slide)
    const carouselItems = carousel.locator('[data-testid^="carousel-item-"]');
    const itemCount = await carouselItems.count();
    let activeCard = null;

    // Find the visible/active carousel item
    for (let i = 0; i < itemCount; i++) {
      const item = carouselItems.nth(i);
      const isVisible = await item.isVisible();
      if (isVisible) {
        activeCard = item.locator('[data-testid="haiku-card"]');
        break;
      }
    }

    if (!activeCard) {
      // Fallback to first card if none found visible
      activeCard = carousel.locator('[data-testid="haiku-card"]').first();
    }

    const mainDisplayLines = activeCard.locator('[data-testid="haiku-japanese-line"]');
    const mainCount = await mainDisplayLines.count();
    const lines: string[] = [];

    if (mainCount > 0) {
      for (let i = 0; i < mainCount; i++) {
        const haikuLine = mainDisplayLines.nth(i);
        const japaneseText = await haikuLine.innerText();
        lines.push(japaneseText);
      }
    }

    const mainHaikuContent = lines.join("").replace(/\s/g, "");
    return mainHaikuContent;
  }

  async checkHaikuDisplay(page: Page): Promise<void> {
    const chatHaikuContent = await this.extractChatHaikuContent(page);

    await page.waitForTimeout(3000);

    // Check that the haiku exists somewhere in the carousel
    const carousel = page.locator('[data-testid="haiku-carousel"]');
    await carousel.waitFor({ state: "visible", timeout: 10000 });

    const allCarouselCards = carousel.locator('[data-testid="haiku-card"]');
    const cardCount = await allCarouselCards.count();

    let foundMatch = false;
    for (let i = 0; i < cardCount; i++) {
      const card = allCarouselCards.nth(i);
      const lines = card.locator('[data-testid="haiku-japanese-line"]');
      const lineCount = await lines.count();
      const cardLines: string[] = [];

      for (let j = 0; j < lineCount; j++) {
        const text = await lines.nth(j).innerText();
        cardLines.push(text);
      }

      const cardContent = cardLines.join("").replace(/\s/g, "");
      if (cardContent === chatHaikuContent) {
        foundMatch = true;
        break;
      }
    }

    expect(foundMatch).toBe(true);
  }
}
