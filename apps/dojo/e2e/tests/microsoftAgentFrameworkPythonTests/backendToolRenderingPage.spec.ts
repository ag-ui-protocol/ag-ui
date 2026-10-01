import { test } from "../../test-isolation-helper";
import { BackendToolRenderingPage } from "../../featurePages/BackendToolRenderingPage";

// Tool calls come from the shared backend-tool-rendering aimock fixtures.
// Humidity comes from agent_framework_ag_ui_examples' simulated get_weather:
// "san francisco" has its own entry (85%); "New York" misses the
// "new york city" key and falls back to the default entry (50%).
test("[MS Agent Framework Python] Backend Tool Rendering renders the get_weather call and result", async ({
  page,
}) => {
  await page.goto(
    "/microsoft-agent-framework-python/feature/backend_tool_rendering",
  );

  const weather = new BackendToolRenderingPage(page);

  await weather.askViaSuggestion("Weather in San Francisco");
  await weather.expectLatestWeatherCard({
    city: /San Francisco/i,
    humidity: 85,
  });

  await weather.askViaSuggestion("Weather in New York");
  await weather.expectLatestWeatherCard({ city: /New York/i, humidity: 50 });
});
