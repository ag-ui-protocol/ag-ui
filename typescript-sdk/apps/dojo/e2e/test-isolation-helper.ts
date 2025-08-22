import { test as base, Page } from "@playwright/test";

// Extend base test with isolation setup
export const test = base.extend<{}, {}>({
  page: async ({ page }, use) => {
    // Before each test - ensure clean state
    await page.context().clearCookies();
    await page.context().clearPermissions();

    // Add delay to ensure AI services are ready
    await page.waitForTimeout(1000);

    await use(page);

    // After each test - cleanup
    await page.context().clearCookies();
  },
});

// Add AI-specific wait helpers for better reliability
export async function waitForAIResponse(page: Page, timeout: number = 90000) {
  // Wait for AI response indicators
  await page.waitForFunction(
    () => {
      // Look for common AI loading indicators
      const loadingIndicators = document.querySelectorAll(
        '[data-testid*="loading"], .loading, .spinner'
      );
      return loadingIndicators.length === 0;
    },
    { timeout }
  );

  // Additional wait for content to stabilize
  await page.waitForTimeout(2000);
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
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}

export { expect } from "@playwright/test";
