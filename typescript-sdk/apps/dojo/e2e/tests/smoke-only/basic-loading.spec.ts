import { test, expect } from "@playwright/test";

test.describe("Demo Apps Loading Smoke Tests", () => {
  test("[Smoke] AG2 Agentic Chat app loads successfully", async ({ page }) => {
    await page.goto(
      "https://ag2-feature-viewer.vercel.app/feature/agentic_chat"
    );

    // Just verify the page loads and key elements are present
    await expect(
      page.getByRole("button", { name: "Agentic Chat Chat with your" })
    ).toBeVisible();
    await expect(page.getByText("Hi, I'm an agent. Want to")).toBeVisible();

    // Click to open chat
    await page
      .getByRole("button", { name: "Agentic Chat Chat with your" })
      .click();

    // Verify chat interface appears (not AI response)
    await expect(
      page.getByRole("textbox", { name: "Type a message..." })
    ).toBeVisible();
    await expect(
      page.locator('[data-test-id="copilot-chat-ready"]')
    ).toBeVisible();
  });

  test("[Smoke] Human in the Loop app loads successfully", async ({ page }) => {
    await page.goto(
      "https://ag2-feature-viewer.vercel.app/feature/human_in_the_loop"
    );

    await expect(
      page.getByRole("button", { name: "Human in the loop Plan a task" })
    ).toBeVisible();

    // Click to open chat
    await page
      .getByRole("button", { name: "Human in the loop Plan a task" })
      .click();

    // Verify chat interface appears
    await expect(
      page.getByRole("textbox", { name: "Type a message..." })
    ).toBeVisible();
    await expect(
      page.locator('[data-test-id="copilot-chat-ready"]')
    ).toBeVisible();
  });

  test("[Smoke] CoBankKit loads successfully", async ({ page }) => {
    await page.goto("https://co-bank-kit.vercel.app/");

    // Verify the app loads - just check that the page responds
    await expect(page.locator("body")).toBeVisible();

    // Wait for page to fully load and check for any interactive elements
    await page.waitForLoadState("networkidle");

    // Check for any visible content (more generic)
    const hasAnyContent = await page.locator("*").count();
    expect(hasAnyContent).toBeGreaterThan(1); // At least html and body
  });

  test("[Smoke] AG2 feature viewer homepage loads", async ({ page }) => {
    await page.goto("https://ag2-feature-viewer.vercel.app/");

    // Verify the homepage loads
    await expect(page.locator("body")).toBeVisible();

    // Check that we can navigate to features
    const hasFeatureLinks = await page.locator("a, button").count();
    expect(hasFeatureLinks).toBeGreaterThan(0);
  });
});
