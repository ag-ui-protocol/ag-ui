import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import { sendChatMessage, awaitLLMResponseDone } from "../utils/copilot-actions";

/**
 * Page object for A2UI feature tests (fixed schema, dynamic schema, advanced).
 * Provides helpers for interacting with the chat and asserting A2UI surface rendering.
 */
export class A2UIPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly assistantMessages: Locator;
  readonly userMessages: Locator;

  constructor(page: Page) {
    this.page = page;
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.sendButton = CopilotSelectors.sendButton(page);
    this.assistantMessages = CopilotSelectors.assistantMessages(page);
    this.userMessages = CopilotSelectors.userMessages(page);
  }

  async openChat() {
    try {
      await CopilotSelectors.chatToggle(this.page).click({ timeout: 3000 });
    } catch {
      // Chat may already be open
    }
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  async assertUserMessageVisible(text: string | RegExp) {
    await expect(this.userMessages.getByText(text)).toBeVisible();
  }

  async assertAgentReplyVisible(expectedText: RegExp | RegExp[]) {
    const patterns = Array.isArray(expectedText) ? expectedText : [expectedText];
    let lastError: unknown = null;
    for (const pattern of patterns) {
      try {
        const msg = this.assistantMessages.filter({ hasText: pattern });
        await expect(msg.last()).toBeVisible();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Locate an A2UI surface container by its surface ID */
  surface(surfaceId: string): Locator {
    return this.page.locator(`[data-surface-id="${surfaceId}"]`);
  }

  /** Locate any A2UI surface container (when surface ID is unknown) */
  anySurface(): Locator {
    return this.page.locator("[data-surface-id]");
  }

  /** Assert that at least one A2UI surface is rendered on the page */
  async assertSurfaceVisible(timeout = 30_000) {
    await expect(this.anySurface().first()).toBeVisible({ timeout });
  }

  /** Assert a surface with a specific ID is rendered */
  async assertSurfaceWithIdVisible(surfaceId: string, timeout = 30_000) {
    await expect(this.surface(surfaceId)).toBeVisible({ timeout });
  }

  /** Assert the rendered surface contains the given text */
  async assertSurfaceContainsText(text: string | RegExp, timeout = 30_000) {
    const surface = this.anySurface().first();
    await expect(surface).toBeVisible({ timeout });
    if (typeof text === "string") {
      await expect(surface).toContainText(text, { timeout });
    } else {
      await expect(surface.getByText(text)).toBeVisible({ timeout });
    }
  }

  /** Assert multiple texts are present within any rendered surfaces */
  async assertSurfaceContainsAll(texts: (string | RegExp)[], timeout = 10_000) {
    for (const text of texts) {
      await this.assertSurfaceContainsText(text, timeout);
    }
  }

  /** Count the number of rendered A2UI surfaces */
  async getSurfaceCount(): Promise<number> {
    return this.anySurface().count();
  }
}
