import { test, expect } from "@playwright/test";

// Smoke test: ensure CopilotKit homepage loads and renders key content.

test('[Core] CopilotKit homepage renders', async ({ page }) => {
  await page.goto("https://copilotkit.ai/", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveTitle(/CopilotKit/i);

  // Validate hero heading content.
  await expect(
    page.getByRole("heading", {
      name: /Build User-Facing Agentic Applications/i,
      exact: false,
    })
  ).toBeVisible();
});