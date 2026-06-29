import { EventType } from "@ag-ui/client";
import {
  FakeMemory,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

const SIMPLE_STREAM_CHUNKS = [
  { type: "text-delta", payload: { text: "Hello" } },
  { type: "finish", payload: {} },
];

describe("MESSAGES_SNAPSHOT emission", () => {
  it("emits MESSAGES_SNAPSHOT before RUN_FINISHED when memory has messages", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [{ type: "text", text: "Hello" }],
        },
      },
      {
        id: "msg-2",
        role: "assistant",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [{ type: "text", text: "Hi there!" }],
        },
      },
    ];

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const events = await collectEvents(agent, makeInput());

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.MESSAGES_SNAPSHOT);

    // MESSAGES_SNAPSHOT should come before RUN_FINISHED
    const snapshotIdx = types.indexOf(EventType.MESSAGES_SNAPSHOT);
    const finishedIdx = types.indexOf(EventType.RUN_FINISHED);
    expect(snapshotIdx).toBeLessThan(finishedIdx);

    // Verify the snapshot content
    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as any;
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({
      id: "msg-1",
      role: "user",
      content: "Hello",
    });
    expect(snapshot.messages[1]).toMatchObject({
      id: "msg-2",
      role: "assistant",
      content: "Hi there!",
    });
  });

  it("does not emit MESSAGES_SNAPSHOT when memory has no messages", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [];

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const events = await collectEvents(agent, makeInput());

    const types = events.map((e) => e.type);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("does not emit MESSAGES_SNAPSHOT when recalled history is system-only", async () => {
    // System messages are intentionally dropped by convertMastraMessagesToAGUI,
    // which would leave an empty AG-UI snapshot. Emitting that would wipe
    // client-side conversation state.
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "sys-1",
        role: "system",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [{ type: "text", text: "You are a helpful assistant." }],
        },
      },
    ];

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const events = await collectEvents(agent, makeInput());

    const types = events.map((e) => e.type);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("does not emit MESSAGES_SNAPSHOT for remote agents", async () => {
    const agent = makeRemoteMastraAgent({
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const events = await collectEvents(agent, makeInput());

    const types = events.map((e) => e.type);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("emits MESSAGES_SNAPSHOT after STATE_SNAPSHOT (working memory)", async () => {
    const memory = new FakeMemory();
    memory.workingMemoryValue = JSON.stringify({ key: "value" });
    memory.recallMessages = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [{ type: "text", text: "Hello" }],
        },
      },
    ];

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const events = await collectEvents(agent, makeInput());

    const types = events.map((e) => e.type);
    const stateIdx = types.indexOf(EventType.STATE_SNAPSHOT);
    const msgsIdx = types.indexOf(EventType.MESSAGES_SNAPSHOT);
    const finishedIdx = types.indexOf(EventType.RUN_FINISHED);

    expect(stateIdx).toBeGreaterThan(-1);
    expect(msgsIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeLessThan(msgsIdx);
    expect(msgsIdx).toBeLessThan(finishedIdx);
  });

  it("still emits RUN_FINISHED if messages snapshot fails", async () => {
    const memory = new FakeMemory();
    // Override recall to throw
    memory.recall = async () => {
      throw new Error("DB connection failed");
    };

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    // Should not throw — best-effort
    const events = await collectEvents(agent, makeInput());
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("suppresses MESSAGES_SNAPSHOT when a client tool call is streamed (HITL)", async () => {
    // A client/frontend tool (e.g. CopilotKit generate_task_steps) renders on
    // the client keyed to the streamed tool-call id. The authoritative snapshot
    // from recall() carries Mastra's stored id, which won't match, so replacing
    // the client's message list would orphan the in-flight HITL render. Suppress.
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: "text", text: "Plan it." }] },
      },
    ];

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "client-1",
            toolName: "generate_task_steps",
            args: { steps: [] },
          },
        },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const types = events.map((e) => e.type);

    // Tool call was emitted, but the snapshot is gated off because it never resolved.
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("suppresses MESSAGES_SNAPSHOT for a backend tool call even when it resolves in-run", async () => {
    // The bridge streams the tool call under the provider id (e.g. OpenAI
    // `call_…`), but the recall()-sourced snapshot carries Mastra's stored id.
    // Replacing the client's message list with mismatched ids orphans the
    // frontend's rendered tool card. Until streamed ids == stored ids, any
    // tool-call turn must suppress the snapshot — not just pending client tools.
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: "text", text: "Weather?" }] },
      },
    ];

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: [
        {
          type: "tool-call",
          payload: {
            toolCallId: "srv-1",
            toolName: "get_weather",
            args: { city: "NYC" },
          },
        },
        {
          type: "tool-result",
          payload: { toolCallId: "srv-1", result: "Sunny" },
        },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(types).not.toContain(EventType.MESSAGES_SNAPSHOT);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("includes tool call messages in the snapshot", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "msg-1",
        role: "user",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [{ type: "text", text: "What's the weather?" }],
        },
      },
      {
        id: "msg-2",
        role: "assistant",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [
            { type: "text", text: "Let me check." },
            {
              type: "tool-invocation",
              toolCallId: "call-1",
              toolName: "get_weather",
              args: { city: "NYC" },
              state: "result",
              result: "Sunny, 25°C",
            },
          ],
        },
      },
    ];

    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: SIMPLE_STREAM_CHUNKS,
    });

    const events = await collectEvents(agent, makeInput());

    const snapshot = events.find((e) => e.type === EventType.MESSAGES_SNAPSHOT) as any;
    expect(snapshot).toBeDefined();
    // user + assistant + tool = 3 messages
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages[0].role).toBe("user");
    expect(snapshot.messages[1].role).toBe("assistant");
    expect(snapshot.messages[2].role).toBe("tool");
    expect(snapshot.messages[2].toolCallId).toBe("call-1");
  });
});
