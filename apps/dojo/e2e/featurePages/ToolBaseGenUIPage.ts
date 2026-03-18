import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import { sendChatMessage, awaitLLMResponseDone } from "../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../lib/constants";

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
    this.haikuAgentIntro = page.getByText(DEFAULT_WELCOME_MESSAGE).first();
    this.messageBox = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.haikuBlock = page.locator('[data-testid="haiku-card"]');
    this.applyButton = page.getByRole("button", { name: "Apply" });
    this.japaneseLines = page.locator('[data-testid="haiku-japanese-line"]');
    this.mainHaikuDisplay = page.locator('[data-testid="haiku-carousel"]');
  }

  async generateHaiku(message: string) {
    await expect(this.messageBox).toBeVisible();
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  async checkGeneratedHaiku() {
    const cards = this.page.locator('[data-testid="haiku-card"]');
    await expect(cards.last()).toBeVisible();
    const mostRecentCard = cards.last();
    await expect(mostRecentCard
      .locator('[data-testid="haiku-japanese-line"]')
      .first()).toBeVisible();
  }

  async extractChatHaikuContent(page: Page): Promise<string> {
    const allHaikuCards = page.locator('[data-testid="haiku-card"]');
    await expect(allHaikuCards.first()).toBeVisible();
    const cardCount = await allHaikuCards.count();
    let chatHaikuContainer;
    let chatHaikuLines;

    for (let cardIndex = cardCount - 1; cardIndex >= 0; cardIndex--) {
      chatHaikuContainer = allHaikuCards.nth(cardIndex);
      chatHaikuLines = chatHaikuContainer.locator('[data-testid="haiku-japanese-line"]');
      const linesCount = await chatHaikuLines.count();

      if (linesCount > 0) {
        try {
          await expect(chatHaikuLines.first()).toBeVisible();
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
    const carousel = page.locator('[data-testid="haiku-carousel"]');
    await expect(carousel).toBeVisible();

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

  private async carouselIncludesHaiku(
    page: Page,
    chatHaikuContent: string,
  ): Promise<boolean> {
    const carousel = page.locator('[data-testid="haiku-carousel"]');

    if (!(await carousel.isVisible())) {
      return false;
    }

    const allCarouselCards = carousel.locator('[data-testid="haiku-card"]');
    const cardCount = await allCarouselCards.count();

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
        return true;
      }
    }

    return false;
  }

  async checkHaikuDisplay(page: Page): Promise<void> {
    const chatHaikuContent = await this.extractChatHaikuContent(page);

    await expect
      .poll(
        async () => this.carouselIncludesHaiku(page, chatHaikuContent),
        { timeout: 15000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
  }
}
