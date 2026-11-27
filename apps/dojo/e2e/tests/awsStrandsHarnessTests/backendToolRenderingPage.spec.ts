import { test } from "../../test-isolation-helper";
import {
  requestStrandsWeather,
  expectStrandsWeatherTurns,
} from "../../featurePages/StrandsWeatherPage";

test("[Strands Harness] Backend Tool Rendering displays weather cards", async ({
  page,
}) => {
  test.setTimeout(30000);
  await page.goto("/aws-strands-harness/feature/backend_tool_rendering", {
    waitUntil: "networkidle",
  });
  await requestStrandsWeather(page, "San Francisco");
  await requestStrandsWeather(page, "New York");
});
