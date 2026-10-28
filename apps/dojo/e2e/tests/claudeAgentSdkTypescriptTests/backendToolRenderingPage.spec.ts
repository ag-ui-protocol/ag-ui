import { test, expect } from "../../test-isolation-helper";
import { BackendToolRenderingPage } from "../../featurePages/BackendToolRenderingPage";

test("[Claude Agent SDK TypeScript] Backend Tool Rendering displays backend weather results", async ({
  page,
}) => {
  await page.goto(
    "/claude-agent-sdk-typescript/feature/backend_tool_rendering",
  );
  const weather = new BackendToolRenderingPage(page);
  for (const city of ["San Francisco", "New York"]) {
    await weather.askViaSuggestion(`Weather in ${city}`);
    await weather.expectLatestWeatherCard({
      city: new RegExp(`^${city}$`),
      humidity: 50,
    });
    await expect(weather.weatherCards.last()).toContainText("20° C");
  }
  await expect(weather.weatherCards).toHaveCount(2);
});
