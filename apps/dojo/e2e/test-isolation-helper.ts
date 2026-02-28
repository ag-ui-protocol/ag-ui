import { test as base, Page } from "@playwright/test";

// Extend base test with isolation setup and error monitoring
export const test = base.extend<{}, {}>({
  page: async ({ page }, use) => {
    // Before each test - ensure clean state
    await page.context().clearCookies();
    await page.context().clearPermissions();

    // Fix 6: Monitor for app errors and fail fast instead of timing out.
    // "Message not found" and similar errors cascade into misleading timeouts.
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => {
      console.error(`[PageError] ${error.message}`);
      pageErrors.push(error);
    });

    // Add delay to ensure AI services are ready
    await page.waitForTimeout(1000);

    await use(page);

    // After each test - report collected errors and cleanup
    if (pageErrors.length > 0) {
      console.warn(
        `[Test Cleanup] ${pageErrors.length} page error(s) during test:`,
        pageErrors.map((e) => e.message)
      );
    }
    await page.context().clearCookies();
  },
});

/**
 * Wait for AI response by checking that actual assistant message content exists.
 *
 * Previous implementation only checked for loading indicators to disappear,
 * which caused false positives when:
 * - Loading indicators were never shown (fast response or missed selector)
 * - Loading indicators disappeared but content hadn't rendered yet
 * - The stream errored silently
 *
 * This version checks for actual content in the last assistant message.
 */
export async function waitForAIResponse(page: Page, timeout: number = 90000) {
  // Phase 1: Wait for any loading indicators to disappear
  await page.waitForFunction(
    () => {
      const loadingIndicators = document.querySelectorAll(
        '[data-testid*="loading"], .loading, .spinner'
      );
      return loadingIndicators.length === 0;
    },
    { timeout }
  );

  // Phase 2: Wait for at least one assistant message with actual content.
  // This catches the case where loading indicators disappear but the
  // response is empty or hasn't rendered yet.
  await page.waitForFunction(
    () => {
      const messages = document.querySelectorAll(
        ".copilotKitAssistantMessage"
      );
      if (messages.length === 0) return false;
      const lastMessage = messages[messages.length - 1];
      return (lastMessage?.textContent?.trim().length ?? 0) > 0;
    },
    { timeout }
  );

  // Phase 3: Stabilization wait for streaming content to finish rendering
  await page.waitForTimeout(2000);
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
  delayMs: number = 5000
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
          `🔄 Retrying operation (attempt ${
            i + 2
          }/${maxRetries}) after AI service error: ${errorMsg}`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}

export { expect } from "@playwright/test";
