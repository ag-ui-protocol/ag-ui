import { test } from "../../test-isolation-helper";
import { A2UIPage } from "../../featurePages/A2UIPage";

// Google Antigravity A2UI advanced. The page is the dynamic-schema demo plus a
// custom `render_a2ui` progress renderer; it runs the same backend agent as
// a2ui_dynamic_schema. generate_a2ui makes its render_a2ui call server-side,
// so no render_a2ui call streams to the page and the custom progress renderer
// never shows for this integration: these tests assert the painted surface
// only. Fixtures: apps/dojo/e2e/antigravity-a2ui-fixtures.ts.

test("[Antigravity] A2UI Advanced renders surface with hotel comparison", async ({
  page,
}) => {
  await page.goto("/antigravity/feature/a2ui_advanced");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a comparison of 3 hotels with name, location, price per night, and star rating using the StarRating component.",
  );

  await a2ui.assertSurfaceWithIdVisible("hotel-comparison");
  await a2ui.assertSurfaceContainsAll([
    "The Ritz",
    "Holiday Inn",
    "Boutique Loft",
  ]);
});

test("[Antigravity] A2UI Advanced renders team directory surface", async ({
  page,
}) => {
  await page.goto("/antigravity/feature/a2ui_advanced");

  const a2ui = new A2UIPage(page);
  await a2ui.openChat();
  await a2ui.sendMessage(
    "Use the generate_a2ui tool to create a team directory with 4 people showing name, role, department, and a Contact button.",
  );

  await a2ui.assertSurfaceWithIdVisible("team-roster");
  await a2ui.assertSurfaceContainsAll([
    "Alice Chen",
    "Bob Martinez",
    "Carol Davis",
    "Dan Wilson",
  ]);
});
