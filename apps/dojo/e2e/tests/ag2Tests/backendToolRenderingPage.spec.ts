import { test } from "../../test-isolation-helper";
import { BackendToolRenderingPage } from "../../featurePages/BackendToolRenderingPage";

// Tool calls come from the shared backend-tool-rendering aimock fixtures.
// Humidity comes from the AG2 example's canned get_weather result, which it
// returns when AG_UI_MOCK_WEATHER is set (dojo-e2e.yml sets it for every lane).
test("[AG2] Backend Tool Rendering renders the get_weather call and result", async ({
  page,
}) => {
  await page.goto("/ag2/feature/backend_tool_rendering");

  const weather = new BackendToolRenderingPage(page);

  await weather.askViaSuggestion("Weather in San Francisco");
  await weather.expectLatestWeatherCard({
    city: /San Francisco/i,
    humidity: 65,
  });
});
