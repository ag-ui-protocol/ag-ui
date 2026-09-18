import { test, expect } from "./test";
import { CopilotSelectors } from "../../utils/copilot-selectors";
import { sendChatMessage, awaitResponseAfterAction } from "../../utils/copilot-actions";
import { DEFAULT_WELCOME_MESSAGE } from "../../lib/constants";
import { captureRuntimeSSE } from "../../utils/runtime-sse";

// `schedule_meeting` is a handler-less backend tool listed under `interrupts`:
// the runtime suspends the call, the run finishes with an interrupt outcome, the
// picker's answer becomes the tool result, and the ORIGINAL call resumes.
const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";
const PAGE_URL = `/${integrationId}/feature/interrupt`;
const BOOK_REQUEST = "Book an intro call with the sales team to discuss pricing.";

test.describe("Interrupt Feature", () => {
  test.use({ timezoneId: "UTC", locale: "en-US" });
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-09-11T09:00:00Z"));
  });

  test("[GitHub Copilot SDK] pauses the tool and the chosen time reaches the resumed call", async ({
    page,
  }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    const pausedRun = captureRuntimeSSE(page, integrationId, "intro call with the sales team");
    await sendChatMessage(page, BOOK_REQUEST);

    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });
    await expect(picker).toContainText(/pricing/i);

    const sse = await pausedRun;
    expect(sse.match(/"type":"TOOL_CALL_RESULT"/g), "paused run carries no tool result").toBeNull();
    expect(sse, "paused run finishes on the interrupt outcome").toContain('"type":"interrupt"');

    const slot = picker.getByRole("button").first();
    const chosen = ((await slot.textContent()) ?? "").trim();
    expect(chosen).not.toBe("");

    const resumedRun = captureRuntimeSSE(page, integrationId, "intro call with the sales team");
    await slot.click();
    expect(await resumedRun).toContain(`Meeting scheduled for ${chosen}`);
    await expect(CopilotSelectors.assistantMessages(page).last()).toContainText(chosen, {
      timeout: 30_000,
    });
  });

  test("[GitHub Copilot SDK] cancelling leaves nothing scheduled", async ({ page }) => {
    await page.goto(PAGE_URL, { waitUntil: "networkidle" });
    await expect(page.getByText(DEFAULT_WELCOME_MESSAGE)).toBeVisible();

    await sendChatMessage(page, BOOK_REQUEST);
    const picker = page.getByTestId("interrupt-picker");
    await expect(picker).toBeVisible({ timeout: 30_000 });

    await awaitResponseAfterAction(page, () => picker.getByTestId("interrupt-cancel").click());
    const reply = CopilotSelectors.assistantMessages(page).last();
    await expect(reply).toContainText(/did not schedule|left your calendar|cancel|not scheduled/i, {
      timeout: 30_000,
    });
    await expect(reply).not.toContainText(/scheduled for/i);
  });
});
