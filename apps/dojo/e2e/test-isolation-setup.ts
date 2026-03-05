import { chromium, FullConfig } from "@playwright/test";
import { setupLLMock } from "./llmock-setup";

async function globalSetup(config: FullConfig) {
  // Start the LLMock server before any tests run
  await setupLLMock();

  console.log("🧹 Setting up test isolation...");

  // Launch browser to clear any persistent state
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Clear all storage
  await context.clearCookies();
  await context.clearPermissions();

  // Try to clear cached data — requires navigating to a real page first
  // (about:blank doesn't allow localStorage access)
  const baseUrl = process.env.BASE_URL;
  if (baseUrl) {
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { timeout: 10_000 });
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        if (window.indexedDB) {
          indexedDB.deleteDatabase("test-db");
        }
      });
    } catch {
      // Page may not be ready yet — individual tests handle their own cleanup
    }
  }

  await browser.close();

  console.log("✅ Test isolation setup complete");
}

export default globalSetup;
