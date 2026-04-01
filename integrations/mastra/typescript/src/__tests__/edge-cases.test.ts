import { vi } from "vitest";
import { EventType } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  FakeMemory,
  FakeLocalAgent,
  FakeRemoteAgent,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
  collectError,
} from "./helpers";

describe("working memory edge cases", () => {
  it("emits STATE_SNAPSHOT with wrapped markdown when working memory is not JSON", async () => {
    const markdown = "# User Profile\n## Personal Info\n- Name:\n- Location:";
    const memory = new FakeMemory();
    memory.workingMemoryValue = markdown;

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );

    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as any).snapshot).toEqual({
      workingMemory: markdown,
    });
  });

  it("emits STATE_SNAPSHOT with parsed JSON when working memory is valid JSON", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = JSON.stringify({
      name: "Alice",
      location: "NYC",
    });

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );

    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as any).snapshot).toEqual({
      name: "Alice",
      location: "NYC",
    });
  });

  it("does not emit STATE_SNAPSHOT when parsed JSON contains $schema", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = JSON.stringify({
      $schema: "http://example.com",
    });

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );

    expect(snapshots).toHaveLength(0);
  });

  it("does not emit STATE_SNAPSHOT when getWorkingMemory returns undefined", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = undefined;

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );

    expect(snapshots).toHaveLength(0);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("does not crash when thread metadata workingMemory is invalid JSON", async () => {
    const memory = new FakeMemory();
    memory.threads.set("thread-1", {
      id: "thread-1",
      title: "",
      metadata: { workingMemory: "not valid json {{{" },
      resourceId: "resource-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({ state: { foo: "bar" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

    const saved = memory.threads.get("thread-1");
    const savedMemory = JSON.parse(saved.metadata.workingMemory);
    expect(savedMemory).toEqual({ foo: "bar" });
  });

  it("creates a new thread and saves state when no thread exists", async () => {
    const memory = new FakeMemory();

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({ state: { userName: "Bob" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

    const saved = memory.threads.get("thread-1");
    expect(saved).toBeDefined();
    const savedMemory = JSON.parse(saved.metadata.workingMemory);
    expect(savedMemory).toEqual({ userName: "Bob" });
  });

  it("merges input state with existing JSON working memory", async () => {
    const memory = new FakeMemory();
    memory.threads.set("thread-1", {
      id: "thread-1",
      title: "",
      metadata: {
        workingMemory: JSON.stringify({ existing: "data", count: 1 }),
      },
      resourceId: "resource-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({ state: { count: 2, newField: "hello" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

    const saved = memory.threads.get("thread-1");
    const savedMemory = JSON.parse(saved.metadata.workingMemory);
    expect(savedMemory).toEqual({
      existing: "data",
      count: 2,
      newField: "hello",
    });
  });

  it("strips messages key from input state before saving to working memory", async () => {
    const memory = new FakeMemory();

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({
        state: {
          messages: [{ id: "1", role: "user", content: "hi" }],
          importantData: "keep",
        },
      }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);

    const saved = memory.threads.get("thread-1");
    const savedMemory = JSON.parse(saved.metadata.workingMemory);
    expect(savedMemory).toEqual({ importantData: "keep" });
  });

  it("skips state management when memory is null", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.getMemory = async () => null as any;

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const events = await collectEvents(
      agent,
      makeInput({ state: { foo: "bar" } }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("skips state management when input.state is empty", async () => {
    const memory = new FakeMemory();

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(
      agent,
      makeInput({ state: {} }),
    );

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(memory.threads.size).toBe(0);
  });
});

describe("error handling", () => {
  it("propagates error chunk from local agent stream to subscriber", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "error", payload: { error: "Something went wrong" } },
      ],
    });

    const { error, events } = await collectError(agent, makeInput());
    expect(error.message).toBe("Something went wrong");

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CHUNK);
  });

  it("propagates error when local agent stream() throws", async () => {
    const fakeAgent = new FakeLocalAgent({ streamChunks: [] });
    fakeAgent.stream = async () => {
      throw new Error("Agent connection failed");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectError(agent, makeInput());
    expect(error.message).toBe("Agent connection failed");
  });

  it("propagates error when remote agent stream() throws", async () => {
    const fakeAgent = new FakeRemoteAgent({ streamChunks: [] });
    fakeAgent.stream = async () => {
      throw new Error("Remote agent unavailable");
    };

    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fakeAgent as any,
      resourceId: "resource-1",
    });

    const { error } = await collectError(agent, makeInput());
    expect(error.message).toBe("Remote agent unavailable");
  });

  it("still emits RUN_FINISHED when getWorkingMemory throws on run finish", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = new FakeMemory();
    memory.getWorkingMemory = async () => {
      throw new Error("Memory service down");
    };

    const agent = makeLocalMastraAgent({ memory, streamChunks: [] });

    const events = await collectEvents(agent, makeInput());

    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to emit working memory snapshot"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});

describe("remote agent path", () => {
  it("both local and remote agents produce the same event types for text streaming", async () => {
    const chunks = [
      { type: "text-delta", payload: { text: "hello" } },
    ];

    const localEvents = await collectEvents(
      makeLocalMastraAgent({ streamChunks: chunks }),
      makeInput(),
    );
    const remoteEvents = await collectEvents(
      makeRemoteMastraAgent({ streamChunks: chunks }),
      makeInput(),
    );

    const localTypes = localEvents.map((e) => e.type);
    const remoteTypes = remoteEvents.map((e) => e.type);

    expect(localTypes).toEqual(remoteTypes);
  });

  it("does not emit STATE_SNAPSHOT for remote agents", async () => {
    const agent = makeRemoteMastraAgent({
      streamChunks: [{ type: "text-delta", payload: { text: "hi" } }],
    });

    const events = await collectEvents(agent, makeInput());
    const snapshots = events.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );

    expect(snapshots).toHaveLength(0);
  });

  it("handles tool calls via processDataStream for remote agents", async () => {
    const agent = makeRemoteMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-r1",
            toolName: "search",
            args: { query: "test" },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "tc-r1",
            result: { results: [] },
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );

    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).toolCallName).toBe("search");
  });
});

describe("event emission details (fake-only)", () => {
  it("assigns new messageId after finish chunk (multi-turn)", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Turn 1" } },
        { type: "finish", payload: {} },
        { type: "text-delta", payload: { text: "Turn 2" } },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const textChunks = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textChunks).toHaveLength(2);

    const messageId1 = (textChunks[0] as any).messageId;
    const messageId2 = (textChunks[1] as any).messageId;

    expect(messageId1).not.toBe(messageId2);
  });

  it("tool call start references current messageId as parentMessageId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Let me check" } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-1",
            toolName: "search",
            args: {},
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const textChunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;
    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;

    expect(toolStart.parentMessageId).toBe(textChunk.messageId);
  });

  it("emits full tool call sequence: START, ARGS, END, RESULT", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "tc-1",
            toolName: "get_weather",
            args: { city: "NYC" },
          },
        },
        {
          type: "tool-result",
          payload: {
            toolCallId: "tc-1",
            result: { temp: 72 },
          },
        },
      ],
    });

    const events = await collectEvents(agent, makeInput());

    const toolEvents = events.filter((e) =>
      [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
      ].includes(e.type),
    );

    expect(toolEvents.map((e) => e.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);

    expect((toolEvents[0] as any).toolCallName).toBe("get_weather");
    expect((toolEvents[1] as any).delta).toBe(
      JSON.stringify({ city: "NYC" }),
    );
    expect((toolEvents[3] as any).content).toBe(
      JSON.stringify({ temp: 72 }),
    );
  });

});
