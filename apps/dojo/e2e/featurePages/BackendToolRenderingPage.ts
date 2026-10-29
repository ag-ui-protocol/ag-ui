import { Page, Locator, expect } from "@playwright/test";
import { awaitLLMResponseDone } from "../utils/copilot-actions";

/**
 * Page object for the shared `backend_tool_rendering` demo: the agent calls its
 * own (backend) `get_weather` tool and the page renders the call + result as a
 * weather card via `useRenderTool`.
 *
 * Specs ask about San Francisco only. The "Tell me about the weather in New
 * York." suggestion never matches the "Weather in New York" aimock fixture, so
 * that turn falls through to the generic "weather" fixture (San Francisco
 * again).
 */
export class BackendToolRenderingPage {
  readonly page: Page;
  readonly weatherCards: Locator;

  constructor(page: Page) {
    this.page = page;
    this.weatherCards = page.getByTestId("weather-card");
  }

  suggestion(name: string): Locator {
    return this.page.getByRole("button", { name });
  }

  /** Click a suggestion chip and wait for the run it starts to finish. */
  async askViaSuggestion(name: string) {
    await expect(this.suggestion(name)).toBeVisible();
    await this.suggestion(name).click();
    await awaitLLMResponseDone(this.page);
  }

  /**
   * Assert the most recent weather card rendered a completed tool call: the
   * city comes from the tool-call arguments and the humidity from the backend
   * tool result, so both halves of the round trip are covered.
   */
  async expectLatestWeatherCard(options: { city: RegExp; humidity: number }) {
    const card = this.weatherCards.last();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("weather-city")).toHaveText(options.city);
    await expect(card.getByTestId("weather-humidity")).toContainText(
      `${options.humidity}%`,
    );
  }
}
