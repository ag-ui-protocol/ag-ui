/**
 * Tests for hook provider independence across threads.
 *
 * Port of Python's test_template_hooks_preservation.py — validates that
 * per-thread agents receive independent hook/config state.
 */

import { describe, it, expect } from "vitest";
import { ToolUseBlock, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import type { AgentStreamEvent } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import type { StrandsAgentConfig, ToolResultContext } from "../config";
import {
  collect,
  minimalRunInput,
  scriptedAgent,
  scriptedStrandsAgent,
} from "./helpers";

function injectThread(
  agent: StrandsAgent,
  threadId: string,
  stub: import("@strands-agents/sdk").Agent,
): void {
  const byThread = (
    agent as unknown as { _agentsByThread: Map<string, unknown> }
  )._agentsByThread;
  byThread.set(threadId, stub);
}

describe("Hook provider — stateFromResult independence across threads", () => {
  it("stateFromResult fires independently per thread", async () => {
    const callLog: { threadId: string; result: unknown }[] = [];

    const config: StrandsAgentConfig = {
      toolBehaviors: {
        my_tool: {
          stateFromResult: (ctx: ToolResultContext) => {
            callLog.push({
              threadId: ctx.inputData.threadId!,
              result: ctx.resultData,
            });
            return { counter: callLog.length };
          },
        },
      },
    };

    const makeEvents = (resultValue: unknown): AgentStreamEvent[] => {
      const block = new ToolUseBlock({
        name: "my_tool",
        toolUseId: "t1",
        input: {},
      });
      const result = new ToolResultBlock({
        toolUseId: "t1",
        status: "success",
        content: [new TextBlock(JSON.stringify(resultValue))],
      });
      return [
        block as unknown as AgentStreamEvent,
        {
          type: "afterToolCallEvent",
          toolUse: { toolUseId: "t1", name: "my_tool", input: {} },
          result,
        } as unknown as AgentStreamEvent,
      ];
    };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "test",
      config,
    });
    injectThread(agent, "thread-A", scriptedAgent(makeEvents({ x: 1 })));
    injectThread(agent, "thread-B", scriptedAgent(makeEvents({ x: 2 })));

    await collect(agent, minimalRunInput({ threadId: "thread-A" }));
    await collect(agent, minimalRunInput({ threadId: "thread-B" }));

    expect(callLog).toHaveLength(2);
    expect(callLog[0].threadId).toBe("thread-A");
    expect(callLog[0].result).toEqual({ x: 1 });
    expect(callLog[1].threadId).toBe("thread-B");
    expect(callLog[1].result).toEqual({ x: 2 });
  });

  it("customResultHandler fires independently per thread", async () => {
    const handlerLog: string[] = [];

    const config: StrandsAgentConfig = {
      toolBehaviors: {
        my_tool: {
          async *customResultHandler(ctx: ToolResultContext) {
            handlerLog.push(ctx.inputData.threadId!);
            yield {
              type: EventType.CUSTOM,
              name: "Hook",
              value: ctx.inputData.threadId,
            };
          },
        },
      },
    };

    const makeEvents = (): AgentStreamEvent[] => {
      const block = new ToolUseBlock({
        name: "my_tool",
        toolUseId: "t1",
        input: {},
      });
      const result = new ToolResultBlock({
        toolUseId: "t1",
        status: "success",
        content: [new TextBlock('"ok"')],
      });
      return [
        block as unknown as AgentStreamEvent,
        {
          type: "afterToolCallEvent",
          toolUse: { toolUseId: "t1", name: "my_tool", input: {} },
          result,
        } as unknown as AgentStreamEvent,
      ];
    };

    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "test",
      config,
    });
    injectThread(agent, "thread-X", scriptedAgent(makeEvents()));
    injectThread(agent, "thread-Y", scriptedAgent(makeEvents()));

    const eventsX = await collect(
      agent,
      minimalRunInput({ threadId: "thread-X" }),
    );
    const eventsY = await collect(
      agent,
      minimalRunInput({ threadId: "thread-Y" }),
    );

    expect(handlerLog).toEqual(["thread-X", "thread-Y"]);

    const customX = eventsX.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as unknown as { name: string }).name === "Hook",
    ) as unknown as { value: string };
    const customY = eventsY.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as unknown as { name: string }).name === "Hook",
    ) as unknown as { value: string };

    expect(customX.value).toBe("thread-X");
    expect(customY.value).toBe("thread-Y");
  });
});

describe("Hook provider — argsStreamer per-tool isolation", () => {
  it("argsStreamer fires only for the configured tool", async () => {
    const streamerLog: string[] = [];

    const config: StrandsAgentConfig = {
      toolBehaviors: {
        streamed_tool: {
          async *argsStreamer(ctx) {
            streamerLog.push(ctx.toolName);
            yield '{"partial":';
            yield '"value"}';
          },
        },
      },
    };

    const block1 = new ToolUseBlock({
      name: "streamed_tool",
      toolUseId: "s1",
      input: { partial: "value" },
    });
    const block2 = new ToolUseBlock({
      name: "other_tool",
      toolUseId: "s2",
      input: { foo: 1 },
    });

    const agent = scriptedStrandsAgent(
      [
        block1 as unknown as AgentStreamEvent,
        block2 as unknown as AgentStreamEvent,
      ],
      { config },
    );

    const events = await collect(agent);
    expect(streamerLog).toEqual(["streamed_tool"]);

    // streamed_tool should have 2 TOOL_CALL_ARGS events (from the streamer)
    const argsEvents = events.filter(
      (e) =>
        e.type === EventType.TOOL_CALL_ARGS &&
        (e as unknown as { toolCallId: string }).toolCallId === "s1",
    );
    expect(argsEvents).toHaveLength(2);

    // other_tool should have 1 TOOL_CALL_ARGS event (default full args)
    const otherArgs = events.filter(
      (e) =>
        e.type === EventType.TOOL_CALL_ARGS &&
        (e as unknown as { toolCallId: string }).toolCallId === "s2",
    );
    expect(otherArgs).toHaveLength(1);
  });
});
