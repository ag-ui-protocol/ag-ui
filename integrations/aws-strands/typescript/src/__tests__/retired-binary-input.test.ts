import { describe, expect, it } from "vitest";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { InputContent } from "@ag-ui/core";
import { convertAguiContentToStrandsDetailed } from "../utils";

describe("AG-UI 1.0 retired binary input", () => {
  it("rejects binary at the protocol boundary", () => {
    expect(
      RunAgentInputSchema.safeParse({
        threadId: "t",
        runId: "r",
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
        messages: [
          {
            id: "u",
            role: "user",
            content: [{ type: "binary", mimeType: "image/png", data: "UE5H" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("reports unvalidated binary as unknown instead of decoding it", async () => {
    const result = await convertAguiContentToStrandsDetailed([
      { type: "binary", mimeType: "image/png", data: "UE5H" },
    ] as unknown as InputContent[]);
    expect(result.blocks).toEqual([]);
    expect(result.dropped).toEqual([
      { type: "binary", reason: "unknown content type" },
    ]);
  });
});
