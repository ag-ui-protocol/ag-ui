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

  async generateHaiku(message: string) {
    await this.messageBox.click();
    await this.messageBox.fill(message);
    await this.sendButton.click();
  }

  async checkGeneratedHaiku() {
    await this.page.locator('[data-testid="haiku-card"]').last().isVisible();
    const mostRecentCard = this.page.locator('[data-testid="haiku-card"]').last();
    await mostRecentCard.locator('[data-testid="haiku-line"]').first().waitFor({ state: 'visible', timeout: 10000 });
  }

  async extractChatHaikuContent(page: Page): Promise<string> {
    // Wait for haiku cards to be visible
    await page.waitForSelector('[data-testid="haiku-card"]', { state: 'visible' });

    const allHaikuCards = page.locator('[data-testid="haiku-card"]');
    const cardCount = await allHaikuCards.count();
    let chatHaikuContainer;
    let chatHaikuLines;

    // Find the most recent haiku card with lines
    for (let cardIndex = cardCount - 1; cardIndex >= 0; cardIndex--) {
      chatHaikuContainer = allHaikuCards.nth(cardIndex);
      chatHaikuLines = chatHaikuContainer.locator('[data-testid="haiku-line"]');

      try {
        // Wait for at least 3 haiku lines to be present in this card
        await page.waitForFunction((cardIdx) => {
          const cards = document.querySelectorAll('[data-testid="haiku-card"]');
          if (cards[cardIdx]) {
            const lines = cards[cardIdx].querySelectorAll('[data-testid="haiku-line"]');
            return lines.length >= 3;
          }
          return false;
        }, cardIndex, { timeout: 10000 });

        // Verify the lines are visible
        await chatHaikuLines.first().waitFor({ state: 'visible', timeout: 5000 });
        break;
      } catch (error) {
        continue;
      }
    }

    if (!chatHaikuLines) {
      throw new Error('No haiku cards with 3 visible lines found');
    }

    const count = await chatHaikuLines.count();
    const lines: string[] = [];

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const haikuLine = chatHaikuLines.nth(i);
        const japaneseText = await haikuLine.locator('p').first().innerText();
        lines.push(japaneseText);
      }
    }

    const chatHaikuContent = lines.join('').replace(/\s/g, '');
    return chatHaikuContent;
  }

  async extractMainDisplayHaikuContent(page: Page): Promise<string> {
    // Wait for the main haiku display to be visible
    await page.waitForSelector('[data-testid="main-haiku-display"]', { state: 'visible' });

    const mainDisplayLines = page.locator('[data-testid="main-haiku-line"]');

    // Wait for at least 3 haiku lines to be present
    await page.waitForFunction(() => {
      const elements = document.querySelectorAll('[data-testid="main-haiku-line"]');
      return elements.length >= 3;
    });

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
    // Wait for both chat and main display to be fully loaded
    await page.waitForTimeout(3000);

    const chatHaikuContent = await this.extractChatHaikuContent(page);

    // Wait a bit more for main display to sync
    await page.waitForTimeout(2000);

    const mainHaikuContent = await this.extractMainDisplayHaikuContent(page);

    if (mainHaikuContent === '') {
      expect(chatHaikuContent.length).toBeGreaterThan(0);
      return;
    }

    // Check if contents match exactly
    if (chatHaikuContent === mainHaikuContent) {
      expect(mainHaikuContent).toBe(chatHaikuContent);
      return;
    }

    // If they don't match, check if one is a substring of the other (partial loading)
    if (mainHaikuContent.includes(chatHaikuContent) || chatHaikuContent.includes(mainHaikuContent)) {
      console.log(`Content partially matches - Chat: "${chatHaikuContent}", Main: "${mainHaikuContent}"`);

      // Wait for content to stabilize and try again
      await page.waitForTimeout(5000);

      const finalChatContent = await this.extractChatHaikuContent(page);
      const finalMainContent = await this.extractMainDisplayHaikuContent(page);

      // Use the longer content as the expected result (more complete)
      const expectedContent = finalChatContent.length >= finalMainContent.length ? finalChatContent : finalMainContent;

      expect(finalMainContent).toBe(expectedContent);
      expect(finalChatContent).toBe(expectedContent);
    } else {
      // Contents are completely different - this might indicate an error
      console.log(`Content mismatch - Chat: "${chatHaikuContent}", Main: "${mainHaikuContent}"`);

      // Wait longer and try one more time
      await page.waitForTimeout(5000);

      const retryMainContent = await this.extractMainDisplayHaikuContent(page);
      const retryChatContent = await this.extractChatHaikuContent(page);

      // At least verify both have content
      expect(retryChatContent.length).toBeGreaterThan(0);
      expect(retryMainContent.length).toBeGreaterThan(0);

      // Try to match again
      expect(retryMainContent).toBe(retryChatContent);
    }
  }
}