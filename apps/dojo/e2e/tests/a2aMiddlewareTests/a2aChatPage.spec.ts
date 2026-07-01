import { test, expect } from "../../test-isolation-helper";
import { A2AChatPage } from "../../pages/a2aMiddlewarePages/A2AChatPage";

// A2A has been hidden from the Dojo menu, so /a2a/feature/a2a_chat now 404s.
// This test is preserved (rather than deleted) so it can be reactivated if/when
// A2A is brought back — at which point the test should also be expanded beyond
// a static tab-bar check to actually exercise the A2A integration end-to-end.
test.describe.skip("A2A Chat Feature", () => {
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
