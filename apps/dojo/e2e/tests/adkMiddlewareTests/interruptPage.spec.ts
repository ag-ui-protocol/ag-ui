import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitResponseAfterAction,
} from "../../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";
import { captureRuntimeSSE } from "../../utils/runtime-sse";

// Native interrupt for Google ADK. The demo's `schedule_meeting` is a backend
// tool that pauses ITSELF: it calls the tool context's `request_confirmation()`,
// which makes ADK emit a long-running `adk_request_confirmation` call and pause
// the invocation. The run finishes with `RUN_FINISHED.outcome = { type:
// "interrupt" }`, the dojo's shared interrupt page renders its time picker, and
// resuming hands the user's choice back as the tool confirmation, so ADK re-runs
// the tool with it.
//
// The chosen time is asserted rather than just the picker disappearing: the card
// hides itself on click, so its absence is true whether or not anything resumed.
// The time the user clicked only exists in the re-run tool's result, so finding
// it there and in the agent's reply is what proves the round trip.
const INTEGRATION_ID = "adk-middleware";
const PAGE_URL = `/${INTEGRATION_ID}/feature/interrupt`;
const BOOK_REQUEST =
  "Book an intro call with the sales team to discuss pricing.";

test.describe("Interrupt Feature", () => {
  test.use({ timezoneId: "UTC", locale: "en-US" });
  test.beforeEach(async ({ page }) => {
    // Meeting choices are derived from the browser date. Fix the input clock
    // so the slot labels are stable across runs.
    await page.clock.setFixedTime(new Date("2026-09-11T09:00:00Z"));
  });

  test("[ADK Middleware] pauses the tool and offers the user a time", async ({
    page,
  }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    // Captured before sending: the run starts on the click.
    const ssePromise = captureRuntimeSSE(
      page,
      INTEGRATION_ID,
      "intro call with the sales team",
    );

    await sendChatMessage(page, BOOK_REQUEST);

    // The picker only mounts on a real pause, so its presence is the interrupt
    // signal, and the slots are what the user has to answer with.
    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("button").first()).toBeEnabled();

    // The card asks the question the paused tool asked. Both values reach the
    // renderer only through the confirmation payload, so a card carrying the
    // page's placeholder heading instead means that payload was dropped between
    // the tool and the user.
    await expect(picker).toContainText("Intro call to discuss pricing");
    await expect(picker).toContainText("with the sales team");

    // The tool has NOT got past the pause: nothing on the wire reports a
    // booking either way, and the run ends on the interrupt outcome rather than
    // a plain finish. Asserted on the wire because the chat cannot show this.
    const sse = await ssePromise;
    expect(
      sse,
      "a run paused inside the tool must not report a booking",
    ).not.toMatch(/Meeting (NOT )?scheduled/);
    expect(
      sse,
      "the paused run must finish on the interrupt outcome",
    ).toContain('"type":"interrupt"');
    expect(sse, "the interrupt must be a tool confirmation").toContain(
      '"reason":"confirmation"',
    );

    // Answered rather than abandoned: a paused invocation left open holds the
    // agent's session waiting on a resume that never arrives.
    await awaitResponseAfterAction(page, () =>
      picker.getByTestId("interrupt-cancel").click(),
    );
  });

  test("[ADK Middleware] resuming carries the chosen time into the tool", async ({
    page,
  }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, BOOK_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    // The label the user is about to click. Read off the button rather than
    // recomputed, since the page generates its slots relative to now.
    const slot = picker.getByRole("button").first();
    const chosen = ((await slot.textContent()) ?? "").trim();
    expect(chosen, "the picker must offer a labelled slot").not.toBe("");

    const ssePromise = captureRuntimeSSE(
      page,
      INTEGRATION_ID,
      "intro call with the sales team",
    );
    await slot.click();

    // The resumed run reaches the tool BODY, which composes its result out of
    // the label that came back. Finding that label in the tool result is what
    // distinguishes a real resume from a run that merely restarted.
    const sse = await ssePromise;
    expect(
      sse,
      "the resumed tool must report the time the user picked",
    ).toContain(`Meeting scheduled for ${chosen}`);

    // And the user sees it: the agent's confirmation names the same slot.
    await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
      chosen,
      { timeout: 30_000 },
    );
  });

  test("[ADK Middleware] cancelling leaves nothing scheduled", async ({
    page,
  }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, BOOK_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    await awaitResponseAfterAction(page, () =>
      picker.getByTestId("interrupt-cancel").click(),
    );

    // The tool takes the cancel path and reports it, so the agent says nothing
    // was scheduled. The negative matters as much as the positive: a cancel that
    // silently resolved would still produce a confirmation.
    const reply = CopilotSelectors.assistantMessages(page).last();
    await expect(reply).toContainText(/did not schedule|left your calendar/i, {
      timeout: 30_000,
    });
    await expect(reply).not.toContainText(/scheduled for/i);
  });
});
