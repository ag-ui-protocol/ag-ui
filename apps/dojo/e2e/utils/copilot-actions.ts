import { Page, expect } from "@playwright/test";
import { CopilotSelectors } from "./copilot-selectors";

/** Default timeout for waiting for LLM response to finish (SSE stream done) */
const LLM_RESPONSE_TIMEOUT = 30_000;
/** Default timeout for finding a DOM element after response */
const ELEMENT_TIMEOUT = 10_000;

/**
 * Wait for the LLM SSE stream to finish.
 * Uses the `data-copilot-running` attribute on the chat container —
 * no arbitrary timeouts or loading-indicator polling needed.
 */
export async function awaitLLMResponseDone(
  page: Page,
  timeout = LLM_RESPONSE_TIMEOUT
) {
  // First wait briefly for the stream to start
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-copilot-running="true"]') !== null,
      null,
      { timeout: 3000 }
    );
  } catch {
    // May have already started and finished, continue
  }
  // Then wait for the stream to finish
  await page.waitForFunction(
    () =>
      document.querySelector('[data-copilot-running="false"]') !== null,
    null,
    { timeout }
  );
}

/**
 * Type a message into the chat input and click send.
 * Replaces the duplicated sendMessage pattern across all page objects.
 */
export async function sendChatMessage(page: Page, message: string) {
  const input = CopilotSelectors.chatTextarea(page);
  await input.click();
  await input.fill(message);
  const sendButton = CopilotSelectors.sendButton(page);
  await sendButton.waitFor({ state: "visible" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
}

/**
 * Send a message and wait for the LLM to finish responding.
 *
 * Uses assistant message counting to avoid a race condition in multi-turn
 * conversations where `data-copilot-running="false"` from the previous
 * response is still present when we start checking.
 */
export async function sendAndAwaitResponse(
  page: Page,
  message: string,
  timeout = LLM_RESPONSE_TIMEOUT
) {
  // Snapshot assistant message count before sending so we can detect
  // when the agent starts responding to THIS message.
  const countBefore = await page
    .locator('[data-testid="copilot-assistant-message"]')
    .count();

  await sendChatMessage(page, message);

  // Wait for a NEW assistant message to appear, proving the agent
  // started responding to our message (not a stale previous response).
  await page.waitForFunction(
    (before) =>
      document.querySelectorAll('[data-testid="copilot-assistant-message"]')
        .length > before,
    countBefore,
    { timeout }
  );

  // Now wait for the stream to finish — at this point the running state
  // belongs to the current response, not a stale one.
  await page.waitForFunction(
    () =>
      document.querySelector('[data-copilot-running="false"]') !== null,
    null,
    { timeout }
  );
}

/**
 * Assert that the last assistant message contains the expected text.
 */
export async function assertAssistantReply(
  page: Page,
  expected: RegExp | string,
  timeout = ELEMENT_TIMEOUT
) {
  const messages = CopilotSelectors.assistantMessages(page);
  const last = messages.last();
  await expect(last).toBeVisible({ timeout });
  if (typeof expected === "string") {
    await expect(last).toContainText(expected, { timeout });
  } else {
    await expect(last.getByText(expected)).toBeVisible({ timeout });
  }
}

/**
 * Assert that a user message is visible in the chat.
 */
export async function assertUserMessage(
  page: Page,
  text: string | RegExp,
  timeout = ELEMENT_TIMEOUT
) {
  const messages = CopilotSelectors.userMessages(page);
  await expect(messages.getByText(text)).toBeVisible({ timeout });
}

/**
 * Open the chat by clicking the toggle button.
 * Silently succeeds if the chat is already open.
 */
export async function openChat(page: Page) {
  try {
    const toggle = CopilotSelectors.chatToggle(page);
    await toggle.click({ timeout: 3000 });
  } catch {
    // Chat may already be open
  }
}

/**
 * Hover over an assistant message to reveal the toolbar, then click regenerate.
 */
export async function regenerateResponse(
  page: Page,
  messageIndex: number
) {
  const message = CopilotSelectors.assistantMessages(page).nth(messageIndex);
  await expect(message).toBeVisible({ timeout: ELEMENT_TIMEOUT });
  await message.hover();
  const regenerate = message.getByTestId("copilot-regenerate-button");
  try {
    await regenerate.click({ timeout: 3000 });
  } catch {
    await regenerate.click({ force: true });
  }
}
