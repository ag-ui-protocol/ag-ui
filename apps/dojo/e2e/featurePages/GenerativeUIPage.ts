import { Page, Locator, expect } from "@playwright/test";
import { CopilotSelectors } from "../utils/copilot-selectors";
import { awaitLLMResponseDone, sendChatMessage } from "../utils/copilot-actions";

/** How long the slider check waits for a request the change should not send. */
const NO_ROUND_TRIP_WINDOW_MS = 1_000;

/** The generative UI demos: send a request, then check the rendered surface. */
export class GenerativeUIPage {
  readonly page: Page;
  readonly chatInput: Locator;
  readonly surface: Locator;
  /** Console messages that report a failed run (CopilotKit logs RUN_ERROR). */
  readonly runErrors: string[] = [];
  /** Requests to the dojo's CopilotKit runtime, which runs the agent. */
  runtimeRequests = 0;

  constructor(page: Page) {
    this.page = page;
    this.chatInput = CopilotSelectors.chatTextarea(page);
    this.surface = page.locator("[data-generative-ui-root]");
    page.on("console", (message) => {
      if (/agent_run_error|RUN_ERROR/.test(message.text())) {
        this.runErrors.push(message.text());
      }
    });
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/copilotkit/")) {
        this.runtimeRequests += 1;
      }
    });
  }

  async sendMessage(message: string) {
    await sendChatMessage(this.page, message);
  }

  /**
   * The plan picker rendered and the run finished: its title, the seat
   * slider and the bound total. The title may be lifted out of the surface
   * into the message's prose (markdown transport), so it is looked up in the
   * whole chat. Moving the slider updates the total in the browser, with no
   * request to the agent.
   */
  async assertPlanPickerRendered() {
    await expect(this.surface.first()).toBeVisible({ timeout: 60_000 });
    await awaitLLMResponseDone(this.page);
    await expect(this.page.getByText("Team plan").first()).toBeVisible();
    const slider = this.surface.getByRole("slider", { name: "Seats" });
    await expect(slider).toBeVisible();
    await expect(this.page.getByText("5 seats selected")).toBeVisible();

    const requestsBefore = this.runtimeRequests;
    // The run itself went through the runtime, so the counter sees its requests.
    expect(requestsBefore, "no request to the runtime was seen").toBeGreaterThan(0);
    await slider.focus();
    await slider.press("ArrowRight");
    await expect(this.page.getByText("6 seats selected")).toBeVisible();
    // A request the change sent would start right away; give it a moment.
    await this.page.waitForTimeout(NO_ROUND_TRIP_WINDOW_MS);
    expect(this.runtimeRequests, "moving the slider sent a request").toBe(
      requestsBefore,
    );
  }

  /**
   * Nothing failed: no component failed to render, the client rejected no
   * operation (the chat card then shows an alert), and no run ended with
   * RUN_ERROR.
   */
  async assertNoRenderErrors() {
    await expect(this.page.locator("[data-generative-ui-error]")).toHaveCount(0);
    await expect(
      this.page.locator('[data-generative-ui-chat-surface] [role="alert"]'),
    ).toHaveCount(0);
    expect(this.runErrors, "a run ended with RUN_ERROR").toEqual([]);
  }
}
