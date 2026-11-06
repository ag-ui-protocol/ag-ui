import { test, expect } from "./test";

const integrationId = process.env.PLAYWRIGHT_SUITE ?? "copilot-sdk-typescript";

test("[GitHub Copilot SDK] Backend Tool Rendering displays weather cards", async ({ page }) => {
  await page.goto(`/${integrationId}/feature/backend_tool_rendering`);

  const sanFrancisco = page.getByRole("button", { name: "Weather in San Francisco" });
  await expect(sanFrancisco).toBeVisible({ timeout: 5000 });
  await sanFrancisco.click();

  await expect(page.getByTestId("weather-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Humidity|Wind/).first()).toBeVisible();
  await expect(page.getByTestId("weather-card").first()).toContainText("20° C");
  await expect(page.getByTestId("weather-humidity").first()).toContainText("50%");

  await page.getByRole("button", { name: "Weather in New York" }).click();
  await expect(page.getByTestId("weather-card")).toHaveCount(2, { timeout: 30_000 });
});
