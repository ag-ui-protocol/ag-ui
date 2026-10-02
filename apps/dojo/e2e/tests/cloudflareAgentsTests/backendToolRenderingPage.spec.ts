import { expect, test } from "../../test-isolation-helper";
import { gotoAndAwaitRuntimeInfo } from "../../utils/copilot-actions";

test("[Cloudflare Agents] Backend Tool Rendering displays a weather card", async ({
  page,
}) => {
  await gotoAndAwaitRuntimeInfo(
    page,
    "/cloudflare-agents/feature/backend_tool_rendering",
  );

  const suggestion = page.getByRole("button", {
    name: "Weather in San Francisco",
  });
  await expect(suggestion).toBeVisible();
  await suggestion.click();

  const card = page.getByTestId("weather-card");
  await expect(card).toBeVisible();
  await expect(card.getByText(/San Francisco/i).first()).toBeVisible();
  // The Worker's get_weather tool returns 20 °C; the card must show its result.
  await expect(card.getByText(/20° C/)).toBeVisible();
});
