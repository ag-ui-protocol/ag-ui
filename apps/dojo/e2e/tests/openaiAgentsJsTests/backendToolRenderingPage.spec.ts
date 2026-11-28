import { expect, test } from "../../test-isolation-helper";

test("[OpenAI Agents JS] Backend Tool Rendering displays a weather card", async ({
  page,
}) => {
  await page.goto("/openai-agents-js/feature/backend_tool_rendering");

  await page.getByRole("button", { name: "Weather in San Francisco" }).click();

  await expect(page.getByTestId("weather-card")).toBeVisible({
    timeout: 30_000,
  });
});
