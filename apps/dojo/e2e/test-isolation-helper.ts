import { test as base, Page } from "@playwright/test";
import { awaitLLMResponseDone } from "./utils/copilot-actions";

// Extend base test with isolation setup
export const test = base.extend<{}, {}>({
  page: async ({ page }, use) => {
    // Before each test - ensure clean state
    await page.context().clearCookies();
    await page.context().clearPermissions();

    await use(page);

    // After each test - cleanup
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

export async function retryOnAIFailure<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 0
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check if this is an AI service error we should retry
      const shouldRetry =
        errorMsg.includes("timeout") ||
        errorMsg.includes("rate limit") ||
        errorMsg.includes("503") ||
        errorMsg.includes("502") ||
        errorMsg.includes("AI response") ||
        errorMsg.includes("network");

      if (shouldRetry && i < maxRetries - 1) {
        console.log(
          `🔄 Retrying operation (attempt ${
            i + 2
          }/${maxRetries}) after AI service error: ${errorMsg}`
        );
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }

      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}

export { expect } from "@playwright/test";
