import { test as base, Page } from "@playwright/test";

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
 * Wait for the AI/agent to finish responding by watching for the
 * CopilotKit send button to become ready (enabled) again, which
 * signals the agent is no longer streaming a response.
 */
export async function waitForAIResponse(page: Page, timeout: number = 90000) {
  // Wait for the send button to reappear and be enabled, indicating the
  // agent has finished responding. This is more reliable than looking for
  // generic loading spinners.
  await page
    .locator('[data-test-id="copilot-chat-ready"]')
    .or(page.getByRole("button", { name: /send/i }))
    .or(page.locator('button[type="submit"]'))
    .first()
    .waitFor({ state: "visible", timeout });

  // Brief stabilization wait for DOM to finish updating after stream ends
  await page.waitForTimeout(500);
}

/**
 * Retry an entire test operation on failure. Always retries on any error
 * since these are e2e tests against an LLM backend where any failure
 * could be transient.
 */
export async function retryOnAIFailure<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 5000
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (i < maxRetries - 1) {
        console.log(
          `🔄 Retrying operation (attempt ${i + 2}/${maxRetries}) after error: ${lastError.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
    }
  }

  throw lastError ?? new Error("Max retries exceeded");
}

export { expect } from "@playwright/test";
