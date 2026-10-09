import { expect, type Page } from "@playwright/test";
import type { TraceEvent } from "../lib/event-trace-events";

export async function requestStrandsWeather(page: Page, city: string) {
  await page
    .getByRole("button", { name: `Weather in ${city}`, exact: true })
    .click();
  const card = page.getByTestId("weather-card").filter({
    has: page
      .getByTestId("weather-city")
      .filter({ hasText: new RegExp(`^${city}$`) }),
  });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("weather-city")).toHaveText(city);
  await expect(card).toContainText("72° C");
  await expect(card).toContainText("sunny");
  await expect(card.getByTestId("weather-humidity")).toHaveText("Humidity45%");
  await expect(card.getByTestId("weather-wind")).toHaveText("Wind8 mph");
  await expect(card.getByTestId("weather-feels-like")).toHaveText(
    "Feels Like74°",
  );
}

export function expectStrandsWeatherTurns(events: readonly TraceEvent[]) {
  const calls = events.filter(
    (event) =>
      event.type === "TOOL_CALL_START" && event.toolCallName === "get_weather",
  );
  expect(calls).toHaveLength(2);
  const ids = calls.map((event) => event.toolCallId);
  expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(2);
  const locations = ids.map((id) => {
    const args = events.filter(
      (event) => event.type === "TOOL_CALL_ARGS" && event.toolCallId === id,
    );
    expect(args.every((event) => typeof event.delta === "string")).toBe(true);
    const parsed: unknown = JSON.parse(
      args.map((event) => event.delta).join(""),
    );
    return parsed;
  });
  expect(locations).toEqual([
    { location: "San Francisco" },
    { location: "New York" },
  ]);
}
