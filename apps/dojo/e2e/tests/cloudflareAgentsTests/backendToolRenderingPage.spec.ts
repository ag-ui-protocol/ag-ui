import { expect, test } from "../../test-isolation-helper";
import { BackendToolRenderingPage } from "../../featurePages/BackendToolRenderingPage";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";

test("[Cloudflare Agents] Backend Tool Rendering renders a new weather card for each request", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(
    page,
    "/cloudflare-agents/feature/backend_tool_rendering",
  );

  const weather = new BackendToolRenderingPage(page);

  // The Worker's get_weather tool returns canned data (humidity 50%).
  await weather.askViaSuggestion("Weather in San Francisco");
  await weather.expectLatestWeatherCard({ city: /San Francisco/i, humidity: 50 });

  // A second request in the same conversation must be a new tool call, not
  // arguments appended to the first one.
  await weather.askViaSuggestion("Weather in New York");
  await expect(weather.weatherCards).toHaveCount(2);
  await weather.expectLatestWeatherCard({ city: /New York/i, humidity: 50 });
});
