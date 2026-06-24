/**
 * Hook exceptions must be logged with the raw Error object so Node prints
 * the stack trace, not `String(e)` which produces "Error: boom" with no
 * context.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType } from "@ag-ui/core";
import { collect, minimalRunInput, scriptedStrandsAgent } from "./helpers";

describe("hook error logging", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    spy?.mockRestore();
  });

  it("stateContextBuilder exception logs the Error object", async () => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const agent = scriptedStrandsAgent([]);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      stateContextBuilder: () => {
        throw new Error("builder bombed");
      },
    };
    await collect(
      agent,
      minimalRunInput({
        messages: [{ id: "u1", role: "user", content: "hi" }],
      }),
    );
    // First arg is the prefix string, second is the Error itself.
    expect(spy).toHaveBeenCalled();
    const lastCall = spy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("stateContextBuilder"),
    );
    expect(lastCall).toBeTruthy();
    expect(lastCall?.[1]).toBeInstanceOf(Error);
    expect((lastCall?.[1] as Error).message).toBe("builder bombed");
  });

  it("stateFromArgs exception logs the Error object", async () => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Emit a tool-use block so the hook site fires.
    const { ToolUseBlock } = await import("@strands-agents/sdk");
    const block = new ToolUseBlock({
      name: "Multiply",
      toolUseId: "u1",
      input: { a: 1, b: 2 },
    });
    const agent = scriptedStrandsAgent([block]);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        Multiply: {
          stateFromArgs: () => {
            throw new Error("args hook bombed");
          },
        },
      },
    };
    await collect(agent);
    const lastCall = spy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("stateFromArgs"),
    );
    expect(lastCall).toBeTruthy();
    expect(lastCall?.[1]).toBeInstanceOf(Error);
    expect((lastCall?.[1] as Error).message).toBe("args hook bombed");
  });

  it("argsStreamer exception logs the Error and emits hook_error event", async () => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ToolUseBlock } = await import("@strands-agents/sdk");
    const block = new ToolUseBlock({
      name: "Multiply",
      toolUseId: "u1",
      input: { a: 1, b: 2 },
    });
    const agent = scriptedStrandsAgent([block]);
    // eslint-disable-next-line require-yield
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        Multiply: {
          argsStreamer: async function* () {
            throw new Error("streamer bombed");
          },
        },
      },
    };
    const events = await collect(agent);
    const lastCall = spy.mock.calls.find((c: unknown[]) =>
      String(c[0] ?? "").includes("argsStreamer"),
    );
    expect(lastCall).toBeTruthy();
    expect(lastCall?.[1]).toBeInstanceOf(Error);
    expect((lastCall?.[1] as Error).message).toBe("streamer bombed");
    // hook_error CUSTOM event should fire instead of fallback args.
    const hookError = events.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as unknown as { name: string }).name === "hook_error",
    ) as unknown as { value: { hook: string; tool: string; error: string } };
    expect(hookError).toBeTruthy();
    expect(hookError.value.hook).toBe("argsStreamer");
    expect(hookError.value.tool).toBe("Multiply");
    expect(hookError.value.error).toBe("streamer bombed");
  });

  it("argsStreamer mid-stream failure does not replay full args (corrupt-args guard)", async () => {
    // If the streamer emitted partial chunks then threw, the catch block must
    // NOT yield the full argsStr again — the frontend concatenates
    // TOOL_CALL_ARGS deltas, so replaying would produce corrupted JSON like
    // `{"x":{"x":1}`. Verify only the partial chunks emitted before the throw
    // appear in the stream.
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ToolUseBlock } = await import("@strands-agents/sdk");
    const block = new ToolUseBlock({
      name: "Multiply",
      toolUseId: "u1",
      input: { x: 1 },
    });
    const agent = scriptedStrandsAgent([block]);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        Multiply: {
          argsStreamer: async function* () {
            yield '{"x":';
            throw new Error("mid-stream failure");
          },
        },
      },
    };
    const events = await collect(agent);
    const argsEvents = events.filter(
      (e) => e.type === EventType.TOOL_CALL_ARGS,
    ) as unknown as Array<{ delta: string }>;
    const totalArgs = argsEvents.map((e) => e.delta).join("");
    expect(totalArgs).toBe('{"x":');
    // TOOL_CALL_END should still fire so the frontend can close the call.
    expect(
      events.filter((e) => e.type === EventType.TOOL_CALL_END),
    ).toHaveLength(1);
  });

  it("stateFromResult exception emits hook_error CUSTOM event", async () => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: unknown[] = [
      {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "my_tool", toolUseId: "tc1" },
      },
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: '{"a":1}' },
      },
      { type: "modelContentBlockStopEvent" },
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "tc1", name: "my_tool" },
        result: { content: [{ text: '"ok"', type: "textBlock" }] },
      },
    ];
    const agent = scriptedStrandsAgent(events);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        my_tool: {
          stateFromResult: () => {
            throw new Error("result hook failed");
          },
        },
      },
    };
    const output = await collect(agent);
    const hookError = output.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as unknown as { name: string }).name === "hook_error",
    ) as unknown as { value: { hook: string; error: string } };
    expect(hookError).toBeTruthy();
    expect(hookError.value.hook).toBe("stateFromResult");
    expect(hookError.value.error).toBe("result hook failed");
  });

  it("customResultHandler exception emits hook_error CUSTOM event", async () => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: unknown[] = [
      {
        type: "modelContentBlockStartEvent",
        start: { type: "toolUseStart", name: "my_tool", toolUseId: "tc1" },
      },
      {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: '{"a":1}' },
      },
      { type: "modelContentBlockStopEvent" },
      {
        type: "afterToolCallEvent",
        toolUse: { toolUseId: "tc1", name: "my_tool" },
        result: { content: [{ text: '"ok"', type: "textBlock" }] },
      },
    ];
    const agent = scriptedStrandsAgent(events);
    (agent as unknown as { config: Record<string, unknown> }).config = {
      toolBehaviors: {
        my_tool: {
          // eslint-disable-next-line require-yield
          customResultHandler: async function* () {
            throw new Error("custom handler boom");
          },
        },
      },
    };
    const output = await collect(agent);
    const hookError = output.find(
      (e) =>
        e.type === EventType.CUSTOM &&
        (e as unknown as { name: string }).name === "hook_error",
    ) as unknown as { value: { hook: string } };
    expect(hookError).toBeTruthy();
    expect(hookError.value.hook).toBe("customResultHandler");
  });
});
