import { expect, Locator, Page } from "@playwright/test";

/**
 * Wait for AI assistant messages with extended timeout and retry logic
 */
export async function waitForAIResponse(
  locator: Locator,
  pattern: RegExp,
  timeoutMs: number = 120_000 // 2 minutes default
) {
  await expect(locator.getByText(pattern)).toBeVisible({ timeout: timeoutMs });
}

/**
 * Wait for AI-generated content to appear with polling
 */
export async function waitForAIContent(
  locator: Locator,
  timeoutMs: number = 120_000 // 2 minutes default
) {
  await expect(locator).toBeVisible({ timeout: timeoutMs });
}

/**
 * Wait for AI form interactions with extended timeout
 */
export async function waitForAIFormReady(
  locator: Locator,
  timeoutMs: number = 60_000 // 1 minute default
) {
  await expect(locator).toBeVisible({ timeout: timeoutMs });
  await expect(locator).toBeEnabled({ timeout: timeoutMs });
  await expect(locator).toBeEditable({ timeout: timeoutMs });
}

/**
 * Wait for AI dialog/modal to appear
 */
export async function waitForAIDialog(
  locator: Locator,
  timeoutMs: number = 90_000 // 1.5 minutes default
) {
  await expect(locator).toBeVisible({ timeout: timeoutMs });
}

/**
 * Wait for pattern matching with custom timeout for AI responses
 */
export async function waitForAIPatterns(
  page: Page,
  patterns: RegExp[],
  timeoutMs: number = 120_000 // 2 minutes default
): Promise<void> {
  const endTime = Date.now() + timeoutMs;

  while (Date.now() < endTime) {
    for (const pattern of patterns) {
      try {
        const element = page.locator("body").getByText(pattern);
        if ((await element.count()) > 0) {
          await expect(element.first()).toBeVisible({ timeout: 5000 });
          return; // Found a match
        }
      } catch {
        // Continue searching
      }
    }

    await page.waitForTimeout(2000); // Wait 2s before next check
  }

  throw new Error(
    `None of the expected patterns matched within ${timeoutMs}ms: ${patterns
      .map((p) => p.toString())
      .join(", ")}`
  );
}
