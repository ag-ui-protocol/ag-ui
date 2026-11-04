import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// Google Antigravity A2UI error recovery. generate_a2ui runs the toolkit's
// validate->retry loop inside the server tool. The aimock fixtures
// (apps/dojo/e2e/antigravity-a2ui-fixtures.ts) make the first "luxury" render a
// Row whose repeated child references a missing `card` template (structural
// "unresolved child"); the retry, which carries the errors, is valid. "broken"
// is invalid on every attempt, so the tool returns the recovery-exhausted
// envelope and the middleware shows the hard-failure card.

test("[Antigravity] A2UI recovery — invalid render recovers to a valid surface", async ({
  page,
}) => {
  await page.goto("/antigravity/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 luxury hotels with ratings and prices.");

  // Faulty first attempt is suppressed (no wipe); the regenerated valid surface paints.
  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll(["The Ritz", "Holiday Inn", "Boutique Loft"]);
});

test("[Antigravity] A2UI recovery — exhaustion never paints a faulty surface, chat stays usable", async ({
  page,
}) => {
  await page.goto("/antigravity/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  // Every attempt invalid → no faulty surface ever paints (server-side no-wipe
  // guarantee: middleware gate + adapter recovery loop).
  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);

  // Conversation remains usable after the hard failure.
  await a2ui.sendMessage("Thanks anyway.");
});

test("[Antigravity] A2UI recovery — exhaustion shows the hard-failure UI", async ({
  page,
}) => {
  await page.goto("/antigravity/feature/a2ui_recovery");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage("Compare 3 broken hotels with ratings and prices.");

  await expect(a2ui.surface("hotel-comparison")).toHaveCount(0);
  await expect(
    page.getByText("Couldn't generate the UI").first(),
  ).toBeVisible({ timeout: 30_000 });

  await a2ui.sendMessage("Thanks anyway.");
});
