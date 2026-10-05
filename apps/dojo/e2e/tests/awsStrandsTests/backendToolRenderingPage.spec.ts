import { backendToolRenderingPageEventTrace } from "./backendToolRenderingPage.event-trace";
import { test } from "../../event-trace-test";
import {
  requestStrandsWeather,
  expectStrandsWeatherTurns,
} from "../../featurePages/StrandsWeatherPage";

test("[Strands] Backend Tool Rendering displays weather cards", async ({
  page,
  eventTrace,
}) => {
  test.setTimeout(30000);
  await page.goto("/aws-strands/feature/backend_tool_rendering", {
    waitUntil: "networkidle",
  });
  await requestStrandsWeather(page, "San Francisco");
  await requestStrandsWeather(page, "New York");
  await eventTrace.expectJourney(
    backendToolRenderingPageEventTrace.backendToolRenderingDisplaysWeatherCards,
    expectStrandsWeatherTurns,
  );
});
