import { test } from "../../test-isolation-helper";
import { BackendToolRenderingPage } from "../../featurePages/BackendToolRenderingPage";

test("[AgentScope] renders a real backend tool call and its result", async ({
  page,
}) => {
  await page.goto("/agentscope/feature/backend_tool_rendering", {
    waitUntil: "domcontentloaded",
  });
  const weather = new BackendToolRenderingPage(page);
  await weather.askViaSuggestion("Weather in San Francisco");
  await weather.expectLatestWeatherCard({
    city: /San Francisco/i,
    humidity: 65,
  });
});
