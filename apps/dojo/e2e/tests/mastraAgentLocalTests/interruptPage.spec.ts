import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

// Native interrupt (suspend/resume) for Mastra: the agent calls the
// suspend-backed `schedule_meeting` tool, the @ag-ui/mastra bridge emits
// `on_interrupt`, and CopilotKit's v2 `useInterrupt` renders a time picker.
// Choosing a slot resolves the interrupt (resuming the suspended tool).
//
// The backend resume round-trip is additionally covered by the bridge unit
// suite (integrations/mastra/.../interrupt-bridge.test.ts) which asserts the
// exact runId/resumeStream contract; here we exercise the real end-to-end UI:
// suspend surfaces the picker, and resolving it advances the run.
test.describe("Interrupt (Suspend/Resume) Feature", () => {
  test("[Mastra Agent Local] suspends a tool and surfaces the interrupt picker", async ({
    page,
  }) => {
    await page.goto("/mastra-agent-local/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    // Sending this triggers schedule_meeting, which suspends — so there is no
    // assistant text yet; wait on the picker rather than an assistant message.
    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    // The interrupt picker renders, populated from the tool's suspend payload.
    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker).toContainText("sales team");
    await expect(picker.getByRole("button").first()).toBeVisible();
  });

  test("[Mastra Agent Local] resolving the picker advances the run", async ({
    page,
  }) => {
    await page.goto("/mastra-agent-local/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    // Pick the first slot -> resolve() -> the picker is replaced by its
    // booked-result state (the interrupt was addressed).
    await picker.getByRole("button").first().click();
    await expect(page.getByTestId("interrupt-result")).toBeVisible({
      timeout: 30_000,
    });
  });
});
