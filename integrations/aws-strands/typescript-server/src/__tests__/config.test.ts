import {
  PredictStateMapping,
  normalizePredictState,
  maybeAwait,
} from "../config";

describe("config helpers", () => {
  it("normalizes predict state mappings from various inputs", () => {
    const single = new PredictStateMapping({
      stateKey: "city",
      tool: "FetchWeather",
      toolArgument: "city",
    });

    expect(normalizePredictState()).toEqual([]);
    expect(normalizePredictState(null)).toEqual([]);
    expect(normalizePredictState(single)).toEqual([single]);

    const iterator = [single, single];
    expect(normalizePredictState(iterator)).toEqual(iterator);
  });

  it("awaits promises and passthroughs synchronous values", async () => {
    await expect(maybeAwait(Promise.resolve(42))).resolves.toBe(42);
    await expect(maybeAwait(7)).resolves.toBe(7);
  });
});
