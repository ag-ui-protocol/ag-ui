import { test } from "../../test-isolation-helper";
import { BackendToolRenderingPage } from "../../featurePages/BackendToolRenderingPage";

// Tool calls come from the shared backend-tool-rendering aimock fixtures.
// Humidity comes from AGUIDojoServer's static GetWeather (50% for every city).
// Re-check after PNI-515 moves the example to MAF 1.23.
test("[MS Agent Framework .NET] Backend Tool Rendering renders the get_weather call and result", async ({
  page,
}) => {
  await page.goto(
    "/microsoft-agent-framework-dotnet/feature/backend_tool_rendering",
  );

  const weather = new BackendToolRenderingPage(page);

  await weather.askViaSuggestion("Weather in San Francisco");
  await weather.expectLatestWeatherCard({
    city: /San Francisco/i,
    humidity: 50,
  });
});
