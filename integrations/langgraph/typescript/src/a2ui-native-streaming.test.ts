import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { streamRenderSubagent } from "./a2ui-tool";

/** The provider pauses after its first fragment until a graph-stream consumer
 * sees it. A final-only stream cannot satisfy this handshake. */
class GatedRenderModel extends BaseChatModel {
  completed = false;
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  _llmType() {
    return "gated-render-test";
  }
  async _generate(): Promise<ChatResult> {
    throw new Error("Expected callback-selected streaming");
  }
  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    manager?: CallbackManagerForLLMRun,
  ) {
    for (const [index, args] of [
      '{"surfaceId":',
      '"surface",',
      '"components":[],"data":{}}',
    ].entries()) {
      const message = new AIMessageChunk({
        content: "",
        tool_call_chunks: [
          {
            type: "tool_call_chunk",
            index: 0,
            args,
            ...(index === 0 ? { id: "render-call", name: "render_a2ui" } : {}),
          },
        ],
      });
      const chunk = new ChatGenerationChunk({ message, text: "" });
      await manager?.handleLLMNewToken(
        "",
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk },
      );
      yield chunk;
      if (index === 0) await this.gate;
    }
    this.completed = true;
  }
}
const ResultState = Annotation.Root({ result: Annotation<object | null> });
function makeGraph(model: GatedRenderModel) {
  return new StateGraph(ResultState)
    .addNode("render", async () => ({
      result: await streamRenderSubagent(model, "Render", []),
    }))
    .addEdge(START, "render")
    .addEdge("render", END)
    .compile();
}
const expected = { surfaceId: "surface", components: [], data: {} };

describe("A2UI inherited graph streaming callbacks", () => {
  it("delivers native v3 argument fragments before model completion", async () => {
    const model = new GatedRenderModel({});
    const stream = await makeGraph(model).streamEvents(
      { result: null },
      { version: "v3" },
    );
    const args: string[] = [];
    try {
      for await (const event of stream) {
        if (event.method !== "messages") continue;
        const data = event.params.data as {
          event?: string;
          delta?: { fields?: { args?: string } };
        };
        if (
          data.event !== "content-block-delta" ||
          typeof data.delta?.fields?.args !== "string"
        )
          continue;
        args.push(data.delta.fields.args);
        if (args.length === 1) {
          expect(model.completed).toBe(false);
          expect(args[0]).toBe('{"surfaceId":');
          model.release();
        }
      }
      expect(args).toHaveLength(3);
      expect(await stream.values).toEqual({ result: expected });
    } finally {
      model.release();
    }
  });
  it("delivers legacy v2 token callbacks before model completion", async () => {
    const model = new GatedRenderModel({});
    const fragments: string[] = [];
    let finalResult: unknown;
    try {
      for await (const event of makeGraph(model).streamEvents(
        { result: null },
        { version: "v2" },
      )) {
        if (event.event === "on_chat_model_stream") {
          const chunk = event.data.chunk as AIMessageChunk;
          const fragment = chunk.tool_call_chunks?.[0]?.args;
          if (typeof fragment !== "string") continue;
          fragments.push(fragment);
          if (fragments.length === 1) {
            expect(model.completed).toBe(false);
            expect(fragment).toBe('{"surfaceId":');
            model.release();
          }
        }
        if (event.event === "on_chain_end" && event.name === "LangGraph")
          finalResult = event.data.output;
      }
      expect(fragments).toHaveLength(3);
      expect(JSON.parse(fragments.join(""))).toEqual(expected);
      expect(finalResult).toEqual({ result: expected });
    } finally {
      model.release();
    }
  });
});
