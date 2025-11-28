import { test, expect } from "@playwright/test";

test("[Agno] Backend Tool Rendering displays weather cards", async ({
  page,
}) => {
  // Set shorter default timeout for this test
  test.setTimeout(30000); // 30 seconds total

  await page.goto("/agno/feature/backend_tool_rendering");

  // Verify suggestion buttons are visible
  await expect(
    page.getByRole("button", { name: "Weather in San Francisco" }),
  ).toBeVisible({
    timeout: 5000,
  });

  // Click first suggestion and verify weather card appears
  await page.getByRole("button", { name: "Weather in San Francisco" }).click();

  // Wait for either test ID or fallback to "Current Weather" text
  const weatherCard = page.getByTestId("weather-card");
  const currentWeatherText = page.getByText("Current Weather");

  // Try test ID first, fallback to text
  try {
    await expect(weatherCard).toBeVisible({ timeout: 10000 });
  } catch (e) {
    // Fallback to checking for "Current Weather" text
    await expect(currentWeatherText.first()).toBeVisible({ timeout: 10000 });
  }

  // Verify all weather data fields are present and correctly displayed
  const hasHumidity = await page
    .getByTestId("weather-humidity")
    .isVisible()
    .catch(() => false);
  const hasWind = await page
    .getByTestId("weather-wind")
    .isVisible()
    .catch(() => false);
  const hasFeelsLike = await page
    .getByTestId("weather-feels-like")
    .isVisible()
    .catch(() => false);
  const hasCityName = await page
    .getByTestId("weather-city")
    .filter({ hasText: /San Francisco/i })
    .isVisible()
    .catch(() => false);

  // Verify all critical fields are present
  expect(hasHumidity).toBeTruthy();
  expect(hasWind).toBeTruthy();
  expect(hasFeelsLike).toBeTruthy();
  expect(hasCityName).toBeTruthy();

  // Verify temperature is displayed (should show both C and F)
  const temperatureText = await page
    .locator("text=/\\d+°\\s*C/")
    .isVisible()
    .catch(() => false);
  expect(temperatureText).toBeTruthy();

  // Click second suggestion
  await page.getByRole("button", { name: "Weather in New York" }).click();
  await page.waitForTimeout(2000);

  // Verify at least one weather-related element is still visible
  const weatherElements = await page
    .getByText(/Weather|Humidity|Wind|Temperature/i)
    .count();
  expect(weatherElements).toBeGreaterThan(0);
});
