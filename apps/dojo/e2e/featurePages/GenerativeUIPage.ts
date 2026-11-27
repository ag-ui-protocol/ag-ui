import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import { sendChatMessage } from "../utils/copilot-actions";

/** The generative UI demos: send a request, then check the rendered surface. */
export class GenerativeUIPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly surface: Locator;

  constructor(page: Page) {
    this.page = page;
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.surface = page.locator("[data-generative-ui-root]");
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
  }

  /**
   * The plan picker rendered: its title, the seat slider and the bound
   * total. The title may be lifted out of the surface into the message's
   * prose (markdown transport), so it is looked up in the whole chat.
   */
  async assertPlanPickerRendered() {
    await expect(this.surface.first()).toBeVisible({ timeout: 60_000 });
    await expect(this.page.getByText("Team plan").first()).toBeVisible();
    const slider = this.surface.getByRole("slider", { name: "Seats" });
    await expect(slider).toBeVisible();
    await expect(this.page.getByText("5 seats selected")).toBeVisible();
    // The total follows the slider with no round trip to the agent.
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(this.page.getByText("6 seats selected")).toBeVisible();
  }

  /** No surface failed to render. */
  async assertNoRenderErrors() {
    await expect(this.page.locator("[data-generative-ui-error]")).toHaveCount(0);
  }
}
