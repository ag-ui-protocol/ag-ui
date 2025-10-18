import { chromium, FullConfig } from "@playwright/test";

async function globalSetup(config: FullConfig) {
  console.log("🧹 Setting up test isolation...");

  // Launch browser to clear any persistent state
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Clear all storage
  await context.clearCookies();
  await context.clearPermissions();

  // Clear any cached data
  const page = await context.newPage();
  await page.evaluate(() => {
    // Clear all storage types
    localStorage.clear();
    sessionStorage.clear();

    // Clear IndexedDB
    if (window.indexedDB) {
      indexedDB.deleteDatabase("test-db");
    }

    // Clear WebSQL (if supported)
    if (window.openDatabase) {
      try {
        const db = window.openDatabase("", "", "", "");
        db.transaction((tx) => {
          tx.executeSql("DELETE FROM test_table");
        });
      } catch (e) {
        // Ignore WebSQL errors
      }
    }
  });

  await browser.close();

  console.log("✅ Test isolation setup complete");
}

export default globalSetup;
