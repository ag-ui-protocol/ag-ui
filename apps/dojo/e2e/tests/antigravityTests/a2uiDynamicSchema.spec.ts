import { test, expect } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// Google Antigravity A2UI dynamic schema. generate_a2ui is a server tool that
// makes its own forced render_a2ui Gemini call, validates the result and
// returns the a2ui_operations envelope. The aimock fixtures
// (apps/dojo/e2e/antigravity-a2ui-fixtures.ts) answer both the harness' turns
// and that inner call (Gemini-shaped: components/data as JSON strings).

test("[Antigravity] A2UI Dynamic Schema renders hotel comparison surface", async ({
  page,
}) => {
  await page.goto("/antigravity/feature/a2ui_dynamic_schema");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a comparison of 3 hotels with name, location, price per night, and a star rating.",
  );

  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll([
    "The Ritz",
    "Holiday Inn",
    "Boutique Loft",
    "$450/night",
    "$180/night",
    "$320/night",
  ]);

  // HotelCard renders the numeric rating value.
  const surface = a2ui.surface("hotel-comparison");
  await expect(surface.getByText("4.8").first()).toBeVisible();
});
