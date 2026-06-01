/**
 * StrandsAgentConfig.emitChunkEvents collapses START/CONTENT/END triples
 * into self-expanding TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK /
 * REASONING_MESSAGE_CHUNK events.
 */

import { describe, it, expect } from "vitest";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

class ScriptedAgent extends StrandsAgent {
  private readonly _events: BaseEvent[];
  constructor(events: BaseEvent[], emit: boolean) {
    super({
      agent: scriptedAgent(),
      name: "t",
      config: { emitChunkEvents: emit },
    });
    this._events = events;
  }
  // Bypass the real _runRaw logic; emit the scripted events through
  // the public run(), which applies the chunk-collapse filter when
  // emitChunkEvents is true.
  protected async *_runRaw(
    _input: RunAgentInput,
  ): AsyncGenerator<BaseEvent, void, void> {
    for (const e of this._events) yield e;
  }
}

const runInput = (): RunAgentInput =>
  minimalRunInput({ threadId: "t", runId: "r" });

describe("emitChunkEvents collapse", () => {
  const scripted: BaseEvent[] = [
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
      role: "assistant",
    } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "hel",
    } as BaseEvent,
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m1",
      delta: "lo",
    } as BaseEvent,
    { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc1",
      toolCallName: "noop",
      parentMessageId: "m1",
    } as BaseEvent,
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc1",
      delta: "{}",
    } as BaseEvent,
    { type: EventType.TOOL_CALL_END, toolCallId: "tc1" } as BaseEvent,
    { type: EventType.REASONING_MESSAGE_START, messageId: "r1" } as BaseEvent,
    {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "r1",
      delta: "why",
    } as BaseEvent,
    { type: EventType.REASONING_MESSAGE_END, messageId: "r1" } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
  ];

  it("default emits triples, no chunk events", async () => {
    const out = await collect(new ScriptedAgent(scripted, false), runInput());
    const types = out.map((e) => e.type);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CHUNK);
    expect(types).not.toContain(EventType.TOOL_CALL_CHUNK);
    expect(types).not.toContain(EventType.REASONING_MESSAGE_CHUNK);
    expect(
      types.filter((t) => t === EventType.TEXT_MESSAGE_START),
    ).toHaveLength(1);
  });

  it("emitChunkEvents collapses TEXT/TOOL/REASONING triples into chunks, dropping *_END", async () => {
    const out = await collect(new ScriptedAgent(scripted, true), runInput());
    const types = out.map((e) => e.type);
    // Triples replaced with chunks; END events are DROPPED, not translated
    // (client auto-emits TextMessageEnd when the messageId changes or the
    // stream finishes).
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_END);
    expect(types).not.toContain(EventType.TOOL_CALL_START);
    expect(types).not.toContain(EventType.TOOL_CALL_ARGS);
    expect(types).not.toContain(EventType.TOOL_CALL_END);
    expect(types).not.toContain(EventType.REASONING_MESSAGE_START);
    expect(types).not.toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(types).not.toContain(EventType.REASONING_MESSAGE_END);
    // Chunks emitted: START → identity-only chunk, CONTENT(s) → chunks with
    // delta. No trailing END chunk.
    const textChunks = out.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(3); // start + 2 content
    expect((textChunks[0] as unknown as { messageId?: string }).messageId).toBe(
      "m1",
    );
    expect((textChunks[0] as unknown as { role?: string }).role).toBe(
      "assistant",
    );
    expect((textChunks[1] as unknown as { delta?: string }).delta).toBe("hel");
    const toolChunks = out.filter((e) => e.type === EventType.TOOL_CALL_CHUNK);
    expect(toolChunks).toHaveLength(2); // start + args
    expect(
      (toolChunks[0] as unknown as { toolCallName?: string }).toolCallName,
    ).toBe("noop");
    const reasoningChunks = out.filter(
      (e) => e.type === EventType.REASONING_MESSAGE_CHUNK,
    );
    expect(reasoningChunks).toHaveLength(2); // start + content
  });

  it("non-triple events pass through unchanged", async () => {
    const out = await collect(new ScriptedAgent(scripted, true), runInput());
    const types = out.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});
