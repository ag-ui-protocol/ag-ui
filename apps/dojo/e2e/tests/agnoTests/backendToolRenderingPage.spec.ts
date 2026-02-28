import { test, expect, retryOnAIFailure } from "../../test-isolation-helper";

test("[Agno] Backend Tool Rendering displays weather cards", async ({
  page,
}) => {
  await retryOnAIFailure(async () => {
    await page.goto("/agno/feature/backend_tool_rendering");

    // Verify suggestion buttons are visible
    await expect(
      page.getByRole("button", { name: "Weather in San Francisco" }),
    ).toBeVisible({ timeout: 10000 });

    // Click first suggestion and wait for weather card to render
    await page.getByRole("button", { name: "Weather in San Francisco" }).click();

    // Wait for the weather card (backend tool call + render)
    const weatherCard = page.getByTestId("weather-card");
    await expect(weatherCard).toBeVisible({ timeout: 30000 });

    // Verify weather data fields rendered
    await expect(page.getByTestId("weather-humidity")).toBeVisible();
    await expect(page.getByTestId("weather-wind")).toBeVisible();
    await expect(page.getByTestId("weather-feels-like")).toBeVisible();
    await expect(
      page.getByTestId("weather-city").filter({ hasText: /San Francisco/i }),
    ).toBeVisible();

    // Verify temperature is displayed (component renders "{temp}° C")
    await expect(page.locator("text=/\\d+°\\s*C/")).toBeVisible();

    // Click second suggestion and verify weather content still present
    await page.getByRole("button", { name: "Weather in New York" }).click();
    await expect(
      page.getByText(/Weather|Humidity|Wind|Temperature/i).first(),
    ).toBeVisible({ timeout: 30000 });
  });
});
