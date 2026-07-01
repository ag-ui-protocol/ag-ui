import { test, expect } from "../../test-isolation-helper";

test("[StrandsTS] Backend Tool Rendering displays weather cards", async ({
  page,
}) => {
  test.setTimeout(30000);

  await page.goto("/aws-strands-typescript/feature/backend_tool_rendering");

  await expect(
    page.getByRole("button", { name: "Weather in San Francisco" }),
  ).toBeVisible({
    timeout: 5000,
  });

  await page.getByRole("button", { name: "Weather in San Francisco" }).click();

  const weatherCard = page.getByTestId("weather-card");
  const currentWeatherText = page.getByText("Current Weather");

  try {
    await expect(weatherCard).toBeVisible();
  } catch {
    await expect(currentWeatherText.first()).toBeVisible();
  }

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

  expect(hasHumidity || hasWind || hasCityName).toBeTruthy();

  await page.getByRole("button", { name: "Weather in New York" }).click();
  await page.waitForTimeout(2000);

  const weatherElements = await page
    .getByText(/Weather|Humidity|Wind|Temperature/i)
    .count();
  expect(weatherElements).toBeGreaterThan(0);
});
