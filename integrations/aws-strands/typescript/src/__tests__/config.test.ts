import { describe, it, expect } from "vitest";
import {
  normalizePredictState,
  predictStateMappingToPayload,
  maybeAwait,
  type PredictStateMapping,
} from "../config";

describe("normalizePredictState", () => {
  it("returns [] for undefined", () => {
    expect(normalizePredictState(undefined)).toEqual([]);
  });
  it("wraps a single mapping", () => {
    const m: PredictStateMapping = {
      stateKey: "x",
      tool: "t",
      toolArgument: "a",
    };
    expect(normalizePredictState(m)).toEqual([m]);
  });
  it("passes through an iterable", () => {
    const arr: PredictStateMapping[] = [
      { stateKey: "x", tool: "t", toolArgument: "a" },
      { stateKey: "y", tool: "t", toolArgument: "b" },
    ];
    expect(normalizePredictState(arr)).toEqual(arr);
  });
});

describe("predictStateMappingToPayload", () => {
  it("snake-cases the wire-format keys", () => {
    expect(
      predictStateMappingToPayload({
        stateKey: "recipe",
        tool: "set_recipe",
        toolArgument: "data",
      }),
    ).toEqual({
      state_key: "recipe",
      tool: "set_recipe",
      tool_argument: "data",
    });
  });
});

describe("maybeAwait", () => {
  it("awaits promises", async () => {
    await expect(maybeAwait(Promise.resolve(7))).resolves.toBe(7);
  });
  it("returns plain values unchanged", async () => {
    await expect(maybeAwait(42)).resolves.toBe(42);
  });
});
