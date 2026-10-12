/**
 * Which message a non-streamed tool call is attached to.
 *
 * A tool call that never streamed through `OnChatModelStream` is announced
 * from `OnToolEnd` instead. That announcement used to name the tool *result's*
 * id as the call's parent. A ToolMessage usually has no id at that point, so
 * clients hung the call on a stand-in message keyed by the call id, which no
 * MESSAGES_SNAPSHOT would ever recognise.
 *
 * The parent of a tool call is the assistant message whose `tool_calls` hold
 * it. These tests pin that contract on the `OnToolEnd` path. Mirrors the
 * Python integration's test_tool_call_parent_message_id.py.
 */

import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/core";
import { LangGraphAgent } from "./agent";

function createAgent() {
  const agent = new LangGraphAgent({
    deploymentUrl: "http://localhost:2024",
    graphId: "test-graph",
  });
  const dispatched: any[] = [];
  agent.dispatchEvent = (event: any) => {
    dispatched.push(event);
    return event as any;
  };
  (agent as any).activeRun = {
    id: "run-1",
    threadId: "thread-1",
    hasFunctionStreaming: false,
    modelMadeToolCall: false,
  };
  agent.messages = [];
  return { agent, dispatched };
}

function aiMessageWithCall(
  messageId: string,
  toolCallId: string,
  name = "search",
) {
  return {
    type: "ai",
    id: messageId,
    content: "",
    tool_calls: [{ id: toolCallId, name, args: { query: "x" } }],
  };
}

function modelEnd(output: any) {
  return {
    event: "on_chat_model_end",
    metadata: { langgraph_node: "model" },
    data: { output },
  };
}

function toolEnd(toolCallId: string, name = "search") {
  return {
    event: "on_tool_end",
    metadata: { langgraph_node: "tools" },
    data: {
      input: { query: "x" },
      output: { tool_call_id: toolCallId, name, content: "found" },
    },
  };
}

function commandToolEnd(toolCallId: string, name = "search") {
  return {
    event: "on_tool_end",
    metadata: { langgraph_node: "tools" },
    data: {
      input: { query: "x" },
      output: {
        update: {
          messages: [
            {
              type: "tool",
              tool_call_id: toolCallId,
              name,
              content: "found",
              id: "tm-1",
            },
          ],
        },
      },
    },
  };
}

const startFor = (dispatched: any[], toolCallId: string) =>
  dispatched.filter(
    (e) => e.type === EventType.TOOL_CALL_START && e.toolCallId === toolCallId,
  );

describe("OnToolEnd names the assistant message that made a non-streamed call", () => {
  it("names the owning message as parent", () => {
    const { agent, dispatched } = createAgent();

    agent.handleSingleEvent(modelEnd(aiMessageWithCall("ai-1", "tc-1")));
    agent.handleSingleEvent(toolEnd("tc-1"));

    expect(startFor(dispatched, "tc-1")[0].parentMessageId).toBe("ai-1");
  });

  it("reads the owner from a LangChain-serialized model output", () => {
    const { agent, dispatched } = createAgent();

    agent.handleSingleEvent(
      modelEnd({
        lc: 1,
        type: "constructor",
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: aiMessageWithCall("ai-1", "tc-1"),
      }),
    );
    agent.handleSingleEvent(toolEnd("tc-1"));

    expect(startFor(dispatched, "tc-1")[0].parentMessageId).toBe("ai-1");
  });

  it("names the owning message on the Command path, not the tool message", () => {
    const { agent, dispatched } = createAgent();

    agent.handleSingleEvent(modelEnd(aiMessageWithCall("ai-1", "tc-1")));
    agent.handleSingleEvent(commandToolEnd("tc-1"));

    expect(startFor(dispatched, "tc-1")[0].parentMessageId).toBe("ai-1");
  });

  it("keeps each parallel call with its own owner", () => {
    const { agent, dispatched } = createAgent();

    agent.handleSingleEvent(modelEnd(aiMessageWithCall("ai-1", "tc-1")));
    agent.handleSingleEvent(modelEnd(aiMessageWithCall("ai-2", "tc-2")));
    agent.handleSingleEvent(toolEnd("tc-2"));
    agent.handleSingleEvent(toolEnd("tc-1"));

    expect(startFor(dispatched, "tc-1")[0].parentMessageId).toBe("ai-1");
    expect(startFor(dispatched, "tc-2")[0].parentMessageId).toBe("ai-2");
  });

  it("gives a call id seen twice in a run to the later message", () => {
    const { agent, dispatched } = createAgent();

    agent.handleSingleEvent(modelEnd(aiMessageWithCall("ai-1", "tc-1")));
    agent.handleSingleEvent(modelEnd(aiMessageWithCall("ai-2", "tc-1")));
    agent.handleSingleEvent(toolEnd("tc-1"));

    expect(startFor(dispatched, "tc-1")[0].parentMessageId).toBe("ai-2");
  });

  it("sends no parent when this run never saw the owner", () => {
    const { agent, dispatched } = createAgent();

    agent.handleSingleEvent(toolEnd("tc-1"));

    expect(startFor(dispatched, "tc-1")[0].parentMessageId).toBeUndefined();
  });

  it("leaves a streamed call's parent as the chunk id", () => {
    // A streamed START goes out before OnChatModelEnd records any owner; what
    // can go wrong is OnToolEnd announcing the call a second time.
    const { agent, dispatched } = createAgent();
    const streamChunk = (toolCallChunks: unknown[]) => ({
      event: "on_chat_model_stream",
      metadata: { "emit-messages": true, "emit-tool-calls": true },
      data: {
        chunk: {
          id: "ai-stream-1",
          content: "",
          tool_call_chunks: toolCallChunks,
          response_metadata: {},
        },
      },
    });

    agent.handleSingleEvent(
      streamChunk([{ name: "search", args: "", id: "tc-1", index: 0 }]),
    );
    agent.handleSingleEvent(streamChunk([]));
    agent.handleSingleEvent(modelEnd(aiMessageWithCall("ai-end", "tc-1")));
    agent.handleSingleEvent(toolEnd("tc-1"));

    const starts = startFor(dispatched, "tc-1");
    expect(starts).toHaveLength(1);
    expect(starts[0].parentMessageId).toBe("ai-stream-1");
  });
});
