import { test, expect, waitForAIResponse, retryOnAIFailure } from "../../test-isolation-helper";

test("[MastraAgentLocal] Backend Tool Rendering displays weather cards", async ({ page }) => {
  await retryOnAIFailure(async () => {
    await page.goto("/mastra-agent-local/feature/backend_tool_rendering");

    // Verify suggestion buttons are visible
    await expect(page.getByRole("button", { name: "Weather in San Francisco" })).toBeVisible({
      timeout: 15000,
    });

    // Click first suggestion and verify weather card appears
    await page.getByRole("button", { name: "Weather in San Francisco" }).click();
    await waitForAIResponse(page);

    // Wait for weather card to appear — use first() since multiple cards may render
    const weatherCard = page.getByTestId("weather-card").first();
    const currentWeatherText = page.getByText("Current Weather").first();

    await expect(weatherCard.or(currentWeatherText)).toBeVisible({ timeout: 30000 });

    // Verify weather content is present (use flexible selectors)
    const hasHumidity = await page
      .getByText("Humidity")
      .isVisible()
      .catch(() => false);
    const hasWind = await page
      .getByText("Wind")
      .isVisible()
      .catch(() => false);
    const hasCityName = await page
      .locator("h3")
      .filter({ hasText: /San Francisco/i })
      .isVisible()
      .catch(() => false);

    // At least one of these should be true
    expect(hasHumidity || hasWind || hasCityName).toBeTruthy();

    // Click second suggestion
    await page.getByRole("button", { name: "Weather in New York" }).click();
    await waitForAIResponse(page);

    // Verify at least one weather-related element is still visible
    const weatherElements = await page.getByText(/Weather|Humidity|Wind|Temperature/i).count();
    expect(weatherElements).toBeGreaterThan(0);
  });
});
