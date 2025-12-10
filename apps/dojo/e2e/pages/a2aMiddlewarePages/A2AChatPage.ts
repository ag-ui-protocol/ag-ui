import { Page, Locator, expect } from '@playwright/test';

export class A2AChatPage {
  readonly page: Page;
  readonly mainChatTab: Locator;

  constructor(page: Page) {
    this.page = page;
    this.mainChatTab = page.getByRole('tab', {name: 'Main Chat' });
  }

  async openChat() {
    await this.mainChatTab.isVisible();
  }
}
