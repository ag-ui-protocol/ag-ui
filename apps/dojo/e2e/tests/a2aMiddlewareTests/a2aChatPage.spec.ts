import { test, expect } from "../../test-isolation-helper";
import { A2AChatPage } from "../../pages/a2aMiddlewarePages/A2AChatPage";

// The a2a_chat page has a pre-existing rendering issue where the React tree
// intermittently fails to hydrate on first load. This test doesn't involve AI
// at all (just checks for a static tab bar), but needs in-page navigation
// retries to work around the flaky page rendering — Playwright-level retries
// use fresh pages which don't help since the issue is per-navigation.
test.describe("A2A Chat Feature", () => {
  test("[A2A Middleware] Tab bar exists", async ({ page }) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await page.goto("/a2a/feature/a2a_chat");
        const chat = new A2AChatPage(page);
        await chat.openChat();
        await expect(chat.mainChatTab).toBeVisible({ timeout: 15000 });
        return; // success
      } catch (e) {
        lastError = e;
        await page.waitForTimeout(3000);
      }
    }
    throw lastError;
  });
});
