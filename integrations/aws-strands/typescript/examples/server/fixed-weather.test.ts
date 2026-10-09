import { afterEach, expect, it, vi } from "vitest";
import { getWeather } from "./api/backend-tool-rendering";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("replays the complete weather result when deterministic demos are enabled", async () => {
  vi.stubEnv("STRANDS_DEMO_FIXED_WEATHER", "1");
  const expected = {
    temperature: 72,
    conditions: "sunny",
    humidity: 45,
    wind_speed: 8,
    feels_like: 74,
  };
  expect(await getWeather.invoke({ location: "San Francisco" })).toEqual(
    expected,
  );
  expect(await getWeather.invoke({ location: "New York" })).toEqual(expected);
});

it.each([undefined, "0"])(
  "uses normal weather generation when the fixed-weather flag is %s",
  async (flag) => {
    vi.stubEnv("STRANDS_DEMO_FIXED_WEATHER", flag);
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(await getWeather.invoke({ location: "San Francisco" })).toEqual({
      temperature: 60,
      conditions: "sunny",
      humidity: 30,
      wind_speed: 5,
      feels_like: 58,
    });
  },
);
