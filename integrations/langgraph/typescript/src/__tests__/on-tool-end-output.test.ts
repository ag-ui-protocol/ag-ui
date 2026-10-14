import { afterEach, describe, expect, it, vi } from "vitest";
import { LangGraphAgent } from "../agent";

function buildAgent() {
  const agent = new LangGraphAgent({
    graphId: "test-graph",
    deploymentUrl: "http://localhost:8000",
  });
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: true,
  };
  const events: any[] = [];
  (agent as any).dispatchEvent = (event: any) => {
    events.push(event);
    return true;
  };
  return { agent, events };
}

function onToolEnd(output: unknown) {
  return {
    event: "on_tool_end",
    name: "search",
    run_id: "lg-run-1",
    metadata: { langgraph_node: "tools" },
    data: { output, input: { query: "x" } },
  };
}

describe("on_tool_end output shapes", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["undefined", undefined],
    ["a plain string", "raw tool text"],
    ["a list", [{ type: "text", text: "a" }]],
    ["an object without tool_call_id", { content: "no id" }],
  ])(
    "skips %s output without throwing or emitting id-less tool events",
    (_label, output) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { agent, events } = buildAgent();

      expect(() => agent.handleSingleEvent(onToolEnd(output))).not.toThrow();

      expect(events).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect((agent as any).activeRun.modelMadeToolCall).toBe(false);
    },
  );

  it("still emits the tool call and result for a ToolMessage output", () => {
    const { agent, events } = buildAgent();

    agent.handleSingleEvent(
      onToolEnd({
        type: "tool",
        tool_call_id: "call-1",
        name: "search",
        content: "found it",
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);
    expect(events.every((event) => event.toolCallId === "call-1")).toBe(true);
    expect(events[3].content).toBe("found it");
  });
});
