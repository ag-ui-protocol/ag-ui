/** Validate the final structured result returned by the bound model. Native
 * and legacy callback streaming are covered by a2ui-native-streaming.test.ts. */

import { describe, it, expect } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";

import { streamRenderSubagent } from "./a2ui-tool";

// A structurally-valid render_a2ui result.
const VALID_ARGS = {
  surfaceId: "s1",
  components: [
    { id: "root", component: "Column", children: ["t"] },
    { id: "t", component: "Text", text: "hi" },
  ],
  data: {},
};

/** Split JSON into `parts` non-empty fragments, the way a provider streams. */
function argChunks(args: unknown, parts = 4): string[] {
  const text = JSON.stringify(args);
  const size = Math.max(1, Math.floor(text.length / parts));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

/** Fake bound model returning LangChain's assembled tool-call message. */
function fakeBoundModel(args: unknown, callId = "call-1") {
  return {
    async invoke(_messages: unknown[]) {
      let result: AIMessageChunk | undefined;
      for (const [i, fragment] of argChunks(args).entries()) {
        const chunk = new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            {
              name: i === 0 ? "render_a2ui" : undefined,
              args: fragment,
              id: i === 0 ? callId : undefined,
              index: 0,
              type: "tool_call_chunk",
            },
          ],
        });
        result = result ? result.concat(chunk) : chunk;
      }
      return result;
    },
  };
}

describe("streamRenderSubagent", () => {
  it("extracts assembled tool-call arguments", async () => {
    const captured = await streamRenderSubagent(
      fakeBoundModel(VALID_ARGS),
      "PROMPT",
      [],
    );
    expect(captured).toEqual(VALID_ARGS);
  });

  it("returns null when the model produces no render call", async () => {
    const emptyModel = {
      async invoke() {
        return new AIMessageChunk({ content: "" });
      },
    };
    const captured = await streamRenderSubagent(emptyModel, "PROMPT", []);
    expect(captured).toBeNull();
  });
  it("rejects models without invoke instead of hiding a broken integration", async () => {
    await expect(streamRenderSubagent({}, "PROMPT", [])).rejects.toThrow(
      "must provide invoke()",
    );
  });
});
