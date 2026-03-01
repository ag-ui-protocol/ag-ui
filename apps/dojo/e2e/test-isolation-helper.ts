import { test as base, Page } from "@playwright/test";
import { awaitLLMResponseDone } from "./utils/copilot-actions";

/**
 * Dump the current state of assistant messages on the page.
 * Called automatically on test failure so CI logs show what the LLM
 * actually produced (or didn't produce) instead of just "Element not found".
 */
async function dumpPageAIState(page: Page) {
  try {
    const state = await page.evaluate(() => {
      const assistantMsgs = Array.from(
        document.querySelectorAll(".copilotKitAssistantMessage")
      );
      const userMsgs = Array.from(
        document.querySelectorAll(".copilotKitUserMessage")
      );
      return {
        assistantMessages: assistantMsgs.map((el, i) => ({
          index: i,
          text: el.textContent?.trim().slice(0, 200) || "(empty)",
        })),
        userMessages: userMsgs.map((el, i) => ({
          index: i,
          text: el.textContent?.trim().slice(0, 200) || "(empty)",
        })),
        url: window.location.href,
      };
    });

    console.log("\n[AI State Dump] URL:", state.url);
    console.log(
      `[AI State Dump] ${state.userMessages.length} user message(s), ${state.assistantMessages.length} assistant message(s)`
    );
    for (const msg of state.userMessages) {
      console.log(`  [User ${msg.index}] ${msg.text}`);
    }
    for (const msg of state.assistantMessages) {
      console.log(`  [Assistant ${msg.index}] ${msg.text}`);
    }
    if (state.assistantMessages.length === 0) {
      console.log("  [Assistant] (no messages — LLM may not have responded)");
    }
  } catch {
    console.log("[AI State Dump] Could not read page state (page may have navigated away)");
  }
}

// Extend base test with isolation setup and error monitoring
export const test = base.extend<{}, {}>({
  page: async ({ page }, use, testInfo) => {
    // Before each test - ensure clean state
    await page.context().clearCookies();
    await page.context().clearPermissions();

    // Monitor for app errors so failed backends surface immediately
    // instead of manifesting as opaque timeouts.
    const pageErrors: Error[] = [];
    const networkErrors: string[] = [];

    page.on("pageerror", (error) => {
      console.error(`[PageError] ${error.message}`);
      pageErrors.push(error);
    });

    // Log browser console errors (e.g. CopilotKit runtime logging API failures)
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[BrowserConsole] ${msg.text()}`);
      }
    });

    // Log failed network requests to CopilotKit/agent endpoints
    page.on("response", (response) => {
      if (response.status() >= 400 && /copilotkit|agui|agent/i.test(response.url())) {
        const msg = `${response.status()} ${response.url()}`;
        console.error(`[NetworkError] ${msg}`);
        networkErrors.push(msg);
      }
    });

    await use(page);

    // On failure: dump what the LLM actually did so CI logs are actionable
    if (testInfo.status !== testInfo.expectedStatus) {
      await dumpPageAIState(page);
    }

    // After each test - report collected errors
    if (pageErrors.length > 0) {
      console.warn(
        `[Test Cleanup] ${pageErrors.length} page error(s) during test:`,
        pageErrors.map((e) => e.message)
      );
    }
    if (networkErrors.length > 0) {
      console.warn(
        `[Test Cleanup] ${networkErrors.length} network error(s) during test:`,
        networkErrors
      );
    }
    await page.context().clearCookies();
  },
});

/**
 * Wait for the AI response to finish (SSE stream complete).
 * Delegates to awaitLLMResponseDone which uses the data-copilot-running attribute.
 */
export async function waitForAIResponse(page: Page, timeout: number = 15000) {
  await awaitLLMResponseDone(page, timeout);
}

/**
 * Wait for a specific number of assistant messages to exist with content.
 * More precise than waitForAIResponse when you know the expected message count.
 */
export async function waitForAssistantMessage(
  page: Page,
  options: {
    minMessages?: number;
    timeout?: number;
    stabilizationMs?: number;
  } = {}
) {
  const {
    minMessages = 1,
    timeout = 90000,
    stabilizationMs = 2000,
  } = options;

  await page.waitForFunction(
    (min: number) => {
      const messages = document.querySelectorAll(
        ".copilotKitAssistantMessage"
      );
      if (messages.length < min) return false;
      const lastMessage = messages[messages.length - 1];
      return (lastMessage?.textContent?.trim().length ?? 0) > 0;
    },
    minMessages,
    { timeout }
  );

  await page.waitForTimeout(stabilizationMs);
}

export async function retryOnAIFailure<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 5000,
  page?: Page
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if this is an AI service error we should retry
      const shouldRetry =
        errorMsg.includes("timeout") ||
        errorMsg.includes("Timeout") ||
        errorMsg.includes("rate limit") ||
        errorMsg.includes("503") ||
        errorMsg.includes("502") ||
        errorMsg.includes("AI response") ||
        errorMsg.includes("network") ||
        errorMsg.includes("Message not found");

      if (shouldRetry && i < maxRetries - 1) {
        console.log(
          `Retrying operation (attempt ${
            i + 2
          }/${maxRetries}) after AI service error: ${errorMsg}`
        );
        // Dump LLM state before retry so CI logs show what the AI did
        if (page) {
          await dumpPageAIState(page);
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}

export { expect } from "@playwright/test";
