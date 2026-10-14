import { test, expect } from "../../test-isolation-helper";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import {
  sendChatMessage,
  awaitResponseAfterAction,
} from "../../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";
import { captureRuntimeSSE } from "../../utils/runtime-sse";

// Native interrupt for Google Antigravity. The demo's `schedule_meeting` is a
// server tool that pauses ITSELF: it calls the adapter's `interrupt()`, which
// parks the tool inside the harness turn and ends the run with
// `RUN_FINISHED.outcome = { type: "interrupt" }`. The dojo's shared interrupt
// page renders its time picker from the interrupt's `metadata.reason`, and
// resuming hands the user's choice back to that same `interrupt()` call so the
// tool body carries on.
//
// Adapted from awsStrandsTests/interruptPage.spec.ts, with one difference: the
// cancel journey sends the page's other suggestion. aimock never sees a tool's
// result on the Antigravity (Gemini) path, so the closing text is chosen by the
// prompt; what proves the cancel reached the tool is the tool's own result on
// the wire, asserted below.
const INTEGRATION_ID = "antigravity";
const PAGE_URL = `/${INTEGRATION_ID}/feature/interrupt`;
const BOOK_REQUEST =
  "Book an intro call with the sales team to discuss pricing.";
const CANCEL_REQUEST = "Schedule a 1:1 with Alice next week to review Q2 goals.";

test.describe("Interrupt Feature", () => {
  test.use({ timezoneId: "UTC", locale: "en-US" });
  test.beforeEach(async ({ page }) => {
    // Meeting choices are derived from the browser date; the fixture's
    // confirmation names the first slot this clock produces.
    await page.clock.setFixedTime(new Date("2026-09-11T09:00:00Z"));
  });

  test("[Antigravity] pauses the tool and offers the user a time", async ({
    page,
  }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    const ssePromise = captureRuntimeSSE(
      page,
      INTEGRATION_ID,
      "intro call with the sales team",
    );

    await sendChatMessage(page, BOOK_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker.getByRole("button").first()).toBeEnabled();

    // Both values reach the card only through the interrupt's own payload.
    await expect(picker).toContainText("Intro call to discuss pricing");
    await expect(picker).toContainText("with the sales team");

    const sse = await ssePromise;
    expect(
      sse.match(/"type":"TOOL_CALL_RESULT"/g),
      "a run paused inside the tool must carry no tool result",
    ).toBeNull();
    expect(
      sse,
      "the paused run must finish on the interrupt outcome",
    ).toContain('"type":"interrupt"');

    // Answered rather than abandoned: a parked tool left open holds the
    // harness turn waiting on a resume that never arrives.
    await awaitResponseAfterAction(page, () =>
      picker.getByRole("button").first().click(),
    );
  });

  test("[Antigravity] resuming carries the chosen time into the tool", async ({
    page,
  }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, BOOK_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    const slot = picker.getByRole("button").first();
    const chosen = ((await slot.textContent()) ?? "").trim();
    expect(chosen, "the picker must offer a labelled slot").not.toBe("");

    const ssePromise = captureRuntimeSSE(
      page,
      INTEGRATION_ID,
      "intro call with the sales team",
    );
    await slot.click();

    // The resumed tool BODY composes its result out of the label that came
    // back, so finding it there distinguishes a real resume from a restart.
    const sse = await ssePromise;
    expect(
      sse,
      "the resumed tool must report the time the user picked",
    ).toContain(`Meeting scheduled for ${chosen}`);

    await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(
      chosen,
      { timeout: 30_000 },
    );
  });

  test("[Antigravity] cancelling leaves nothing scheduled", async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, CANCEL_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker).toContainText("with Alice");

    const ssePromise = captureRuntimeSSE(page, INTEGRATION_ID, "with Alice");
    await awaitResponseAfterAction(page, () =>
      picker.getByTestId("interrupt-cancel").click(),
    );

    // The tool took the cancel path: its own result says so. This is the
    // assertion that depends on the answer, since the reply below is canned.
    const sse = await ssePromise;
    expect(sse, "the resumed tool must report the cancel").toContain(
      "User cancelled. Meeting NOT scheduled",
    );
    expect(sse).not.toContain("Meeting scheduled for");

    const reply = CopilotSelectors.assistantMessages(page).last();
    await expect(reply).toContainText(/did not schedule|left your calendar/i, {
      timeout: 30_000,
    });
    await expect(reply).not.toContainText(/scheduled for/i);
  });
});
