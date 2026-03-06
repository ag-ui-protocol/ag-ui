import { expect, Locator, Page } from "@playwright/test";
import { awaitLLMResponseDone } from "./copilot-actions";

/**
 * Wait for AI assistant messages with extended timeout and retry logic.
 */
export async function waitForAIResponse(
  locator: Locator,
  pattern: RegExp,
  timeoutMs: number = 30_000
) {
  await expect(locator.getByText(pattern)).toBeVisible({ timeout: timeoutMs });
}

/**
 * Wait for AI-generated content to appear.
 */
export async function waitForAIContent(
  locator: Locator,
  timeoutMs: number = 30_000
) {
  await expect(locator).toBeVisible({ timeout: timeoutMs });
}

/**
 * Wait for AI form interactions to be ready.
 */
export async function waitForAIFormReady(
  locator: Locator,
  timeoutMs: number = 30_000
) {
  await expect(locator).toBeVisible({ timeout: timeoutMs });
  await expect(locator).toBeEnabled({ timeout: timeoutMs });
  await expect(locator).toBeEditable({ timeout: timeoutMs });
}

/**
 * Wait for AI dialog/modal to appear.
 */
export async function waitForAIDialog(
  locator: Locator,
  timeoutMs: number = 30_000
) {
  await expect(locator).toBeVisible({ timeout: timeoutMs });
}

/**
 * Wait for the LLM to finish, then check for any matching pattern.
 * No more polling loop — waits for stream to end, then asserts.
 */
export async function waitForAIPatterns(
  page: Page,
  patterns: RegExp[],
  timeoutMs: number = 30_000
): Promise<void> {
  // Wait for the LLM stream to complete first
  await awaitLLMResponseDone(page, timeoutMs);

  // Then check for patterns immediately
  for (const pattern of patterns) {
    try {
      const element = page.locator("body").getByText(pattern);
      if ((await element.count()) > 0) {
        await expect(element.first()).toBeVisible({ timeout: 5000 });
        return;
      }
    } catch {
      // Continue to next pattern
    }
  }

  throw new Error(
    `None of the expected patterns matched after LLM response: ${patterns
      .map((p) => p.toString())
      .join(", ")}`
  );
}
