import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";

// Native interrupt (suspend/resume) for Mastra: the agent calls the
// suspend-backed `schedule_meeting` tool, the @ag-ui/mastra bridge ends the
// run with an interrupt outcome, and CopilotKit's v2 `useInterrupt` renders a
// time picker.
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

    // The picker only mounts on a real suspend (driven by the interrupt
    // outcome), so its presence + selectable slots is the interrupt signal.
    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("button").first()).toBeVisible();

    // The topic and attendee come from the suspend payload, which the page reads
    // from `metadata.mastra.suspendPayload`. The aimock fixture always sends the
    // same tool-call args, so these labels are fixed; a broken payload read
    // falls back to the generic "a call" heading and no attendee line.
    await expect(
      picker.getByRole("heading", { name: "Intro call with the sales team" }),
    ).toBeVisible();
    await expect(
      picker.getByText("with the sales team", { exact: true }),
    ).toBeVisible();
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

    // Pick the first slot -> resolve() resumes the run and the picker render
    // unmounts (it renders null once a slot is chosen). The picker being
    // dismissed is the deterministic signal that the interrupt was addressed;
    // the picker UI is ephemeral by design and the agent's text becomes the
    // confirmation. The backend resume round-trip (runId/resumeStream, the
    // RunAgentInput.resume decode) is asserted by the bridge unit suite and a
    // live real-LLM run — not here — because under aimock the resumed run has a
    // residual streaming race (see interrupt-bridge.test.ts).
    await picker.getByRole("button").first().click();
    await expect(picker).toBeHidden({ timeout: 30_000 });
  });
});
