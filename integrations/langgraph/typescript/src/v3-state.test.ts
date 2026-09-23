import { describe, expect, it } from "vitest";
import v2State from "./__fixtures__/v2-greeting-state.json";
import v3State from "./__fixtures__/v3-greeting-state.json";
import { v3StateToV2 } from "./v3-state";

describe("V3 checkpoint snapshot compatibility", () => {
  it("matches the unchanged V2 greeting payload from the browser captures", () => {
    const original = structuredClone(v3State);
    expect(v3StateToV2(v3State)).toEqual(v2State);
    expect(v3State).toEqual(original);
  });

  it("preserves application state and messages already in V2 form", () => {
    const state = {
      ...v2State,
      custom: { type: "function", content: "application value" },
    };
    expect(v3StateToV2(state)).toEqual(state);
  });

  it("does not flatten multimodal content or discard application metadata", () => {
    const message = {
      type: "ai",
      content: [{ type: "image", url: "https://example.com/image.png" }],
      response_metadata: {
        output_version: "v1",
        model_provider: "openai",
        application: "kept",
      },
    };
    expect(v3StateToV2({ messages: [message] })).toEqual({
      messages: [message],
    });
  });
});
