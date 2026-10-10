import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";
import { captureRuntimeSSE, expectRunFinished } from "../../utils/runtime-sse";

// Native interrupt (suspend/resume) for a REMOTE Mastra agent (OSS-380). Same
// flow as the local case (the agent's suspend-backed `schedule_meeting` tool
// suspends, the @ag-ui/mastra bridge ends the run with the standard
// RUN_FINISHED.outcome, CopilotKit v2 `useInterrupt` renders the picker), but
// resume round-trips over @mastra/client-js' `resumeStream` instead of the
// local agent resume stream.
//
// The bridge unit suite (integrations/mastra/.../interrupt-bridge.test.ts) pins
// the remote-resume contract (resumeStream, runId round-trip,
// RunAgentInput.resume decode); here we exercise the real end-to-end flow:
// suspend surfaces the picker, and resolving it resumes the tool with the
// chosen slot and the run finishes with the agent's reply.
const INTEGRATION_ID = "mastra";

test.describe("Interrupt (Suspend/Resume) Feature", () => {
  test("[Mastra] suspends a tool and surfaces the interrupt picker", async ({
    page,
  }) => {
    await page.goto("/mastra/feature/interrupt");
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

  test("[Mastra] resolving the picker advances the run", async ({ page }) => {
    await page.goto("/mastra/feature/interrupt");
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await CopilotSelectors.chatTextarea(page).fill(
      "Book an intro call with the sales team to discuss pricing.",
    );
    await CopilotSelectors.sendButton(page).click();

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    // The label the user is about to click. Read off the button rather than
    // recomputed, since the page generates its slots relative to now.
    const slot = picker.getByRole("button").first();
    const chosen = ((await slot.textContent()) ?? "").trim();
    expect(chosen, "the picker must offer a labelled slot").not.toBe("");

    // The card blanks itself on click, before `resolve()` runs, so its absence
    // proves nothing. Only the resume request carries `chosen_label`, so this
    // captures the resumed run and not the one that suspended.
    const ssePromise = captureRuntimeSSE(page, INTEGRATION_ID, "chosen_label");
    await slot.click();

    // The resumed tool body composes its result from the label that came back,
    // so finding it on the wire is what separates a real resume from a run that
    // restarted or suspended again.
    const sse = await ssePromise;
    expect(
      sse,
      "the resumed tool must report the time the user picked",
    ).toContain(`Meeting scheduled for ${chosen}`);
    expectRunFinished(sse, "resumed run");
    expect(
      sse,
      "the resumed run must not end on another interrupt",
    ).not.toContain('"type":"interrupt"');

    // And the user sees the agent's reply to the resumed tool.
    await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
      "Your meeting is scheduled",
      { timeout: 30_000 },
    );
  });
});
