import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitLLMResponseDone,
} from "../utils/copilot-actions";

/**
 * Page object for the Observational Memory demo. The agent has Mastra
 * Observational Memory enabled; as the conversation grows, Mastra's Observer
 * runs out of band and streams `data-om-*` chunks, which the AG-UI bridge maps
 * to ACTIVITY events. A `renderActivityMessages` renderer draws each OM cycle as
 * a distinct "Observational Memory" card. OM is async, so within a turn the
 * card's terminal state may be "Working", "Completed", or "Activated" — we
 * assert the card surfaces with one of those, not a specific one.
 */
export class ObservationalMemoryPage {
  readonly page: Page;
  readonly messageBox: Locator;
  readonly card: Locator;
  readonly status: Locator;

  constructor(page: Page) {
    this.page = page;
    this.messageBox = CopilotSelectors.chatTextarea(page);
    this.card = page.locator('[data-testid="om-activity-card"]');
    this.status = page.locator('[data-testid="om-activity-status"]');
  }

  async chat(message: string) {
    await expect(this.messageBox).toBeVisible();
    await sendChatMessage(this.page, message);
    await awaitLLMResponseDone(this.page);
  }

  /**
   * Drive a few turns so the conversation crosses the (deliberately low)
   * observation threshold and the Observer fires. OM observation is async, so
   * we poll for the activity card to appear after the turns.
   */
  async driveUntilObservation() {
    await this.chat(
      "I'm planning a two-week trip through Japan in spring. I love food, temples, and trains, and I want to avoid big crowds. Where should I go?",
    );
    await this.chat(
      "Tell me more about the food scene there, and remember that I'm vegetarian and don't drink alcohol.",
    );
    await this.chat(
      "Now suggest a rough day-by-day itinerary for the first week, keeping all of that in mind.",
    );
  }

  async expectObservationActivityCard() {
    const card = this.card.last();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Observational Memory");
    await expect(this.status.last()).toHaveText(
      /Working|Completed|Activated/,
    );
  }
}
