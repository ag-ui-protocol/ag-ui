import { Page, Locator, expect } from '@playwright/test';

export class ToolBaseGenUIPage {
  readonly page: Page;
  readonly haikuAgentIntro: Locator;
  readonly messageBox: Locator;
  readonly sendButton: Locator;
  readonly applyButton: Locator;
  readonly appliedButton: Locator;
  readonly haikuBlock: Locator;
  readonly japaneseLines: Locator;

  constructor(page: Page) {
    this.page = page;
    this.haikuAgentIntro = page.getByText("I'm a haiku generator 👋. How can I help you?");
    this.messageBox = page.getByRole('textbox', { name: 'Type a message...' });
    this.sendButton = page.locator('[data-test-id="copilot-chat-ready"]');
    this.haikuBlock = page.locator('[data-testid="haiku-card"]');
    this.applyButton = page.getByRole('button', { name: 'Apply' });
    this.japaneseLines = page.locator('[data-testid="haiku-line"]');
  }

  async checkGeneratedHaiku() {
    await this.page.locator('[data-testid="haiku-card"]').last().isVisible();
    const mostRecentCard = this.page.locator('[data-testid="haiku-card"]').last();
    await mostRecentCard.locator('[data-testid="haiku-line"]').first().waitFor({ state: 'visible', timeout: 10000 });
  }

  async extractChatHaikuContent(page: Page): Promise<string> {
    await page.waitForTimeout(3000);
    await page.locator('[data-testid="haiku-card"]').first().waitFor({ state: 'visible' });
    const allHaikuCards = page.locator('[data-testid="haiku-card"]');
    const cardCount = await allHaikuCards.count();
    
    const expectedCardCount = await this.getExpectedHaikuCount();
    
    if (cardCount < expectedCardCount) {
      throw new Error(`Expected ${expectedCardCount} haiku cards but found ${cardCount} - haiku generation may have failed`);
    }
    
    const mostRecentCard = allHaikuCards.last();
    const chatHaikuLines = mostRecentCard.locator('[data-testid="haiku-line"]');
    const linesCount = await chatHaikuLines.count();

    if (linesCount === 0) {
      throw new Error('Most recent haiku card has no visible lines - haiku generation failed');
    }

    try {
      await chatHaikuLines.first().waitFor({ state: 'visible', timeout: 5000 });
    } catch (error) {
      throw new Error('Most recent haiku card lines are not visible - haiku generation failed');
    }

    const count = await chatHaikuLines.count();
    const lines: string[] = [];

    for (let i = 0; i < count; i++) {
      const haikuLine = chatHaikuLines.nth(i);
      const japaneseText = await haikuLine.locator('p').first().innerText();
      lines.push(japaneseText);
    }

    const chatHaikuContent = lines.join('').replace(/\s/g, '');
    return chatHaikuContent;
  }

  private haikuGenerationCount = 0;

  async generateHaiku(message: string) {
    await this.messageBox.click();
    await this.messageBox.fill(message);
    await this.sendButton.click();
    this.haikuGenerationCount++;
  }

  async getExpectedHaikuCount(): Promise<number> {
    return this.haikuGenerationCount;
  }

  async extractMainDisplayHaikuContent(page: Page): Promise<string> {
    const mainDisplayLines = page.locator('[data-testid="main-haiku-line"]');
    const mainCount = await mainDisplayLines.count();
    const lines: string[] = [];

    if (mainCount > 0) {
      for (let i = 0; i < mainCount; i++) {
        const haikuLine = mainDisplayLines.nth(i);
        const japaneseText = await haikuLine.locator('p').first().innerText();
        lines.push(japaneseText);
      }
    }

    const mainHaikuContent = lines.join('').replace(/\s/g, '');
    return mainHaikuContent;
  }

  async checkHaikuDisplay(page: Page): Promise<void> {
    const chatHaikuContent = await this.extractChatHaikuContent(page);

    await page.waitForTimeout(5000);

    const mainHaikuContent = await this.extractMainDisplayHaikuContent(page);

    if (mainHaikuContent === '') {
      throw new Error('Main display haiku content is empty - haiku was not properly generated or applied');
    }

    if (chatHaikuContent === mainHaikuContent) {
      expect(mainHaikuContent).toBe(chatHaikuContent);
    } else {
      await page.waitForTimeout(3000);

      const updatedMainContent = await this.extractMainDisplayHaikuContent(page);
      
      if (updatedMainContent === '') {
        throw new Error('Main display haiku content is still empty after additional wait - haiku generation failed');
      }

      expect(updatedMainContent).toBe(chatHaikuContent);
    }
  }
}