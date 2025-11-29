import { EventType } from "@ag-ui/client";
import type { Message, StateDeltaEvent, TextMessageChunkEvent } from "@ag-ui/client";
import {
  convertAGUIMessagesToA2A,
  convertA2AEventToAGUIEvents,
  sendMessageToA2AAgentTool,
  createSharedStateTracker,
  ENGRAM_EXTENSION_URI,
  DEFAULT_ARTIFACT_BASE_PATH,
} from "../utils";

const createMessage = (message: Partial<Message>): Message => message as Message;

describe("convertAGUIMessagesToA2A", () => {
  it("converts AG-UI messages into A2A format while skipping system messages", () => {
    const systemMessage = createMessage({
      id: "sys-1",
      role: "system",
      content: "Follow project guidelines",
    });

    const userMessage = createMessage({
      id: "user-1",
      role: "user",
      content: [
        {
          type: "text",
          text: "Draft a project plan",
        },
      ],
    });

    const assistantMessage = createMessage({
      id: "assistant-1",
      role: "assistant",
      content: "Sure, preparing a plan",
      toolCalls: [
        {
          id: "tool-call-1",
          type: "function",
          function: {
            name: "lookupRequirements",
            arguments: JSON.stringify({ id: 123 }),
          },
        },
      ],
    });

    const toolMessage = createMessage({
      id: "tool-1",
      role: "tool",
      toolCallId: "tool-call-1",
      content: JSON.stringify({ status: "ok" }),
    });

    const converted = convertAGUIMessagesToA2A([
      systemMessage,
      userMessage,
      assistantMessage,
      toolMessage,
    ]);

    expect(converted.contextId).toBeUndefined();
    expect(converted.history).toHaveLength(3);

    const assistantEntry = converted.history.find((entry) => entry.role === "agent");
    expect(assistantEntry?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: "Sure, preparing a plan" }),
        expect.objectContaining({ kind: "data" }),
      ]),
    );

    const toolEntry = converted.history.find((entry) =>
      entry.parts.some(
        (part) =>
          part.kind === "data" &&
          typeof (part as { data?: Record<string, unknown> }).data?.type === "string" &&
          (part as { data?: Record<string, unknown> }).data?.type === "tool-result",
      ),
    );
    expect(toolEntry?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "data", data: expect.objectContaining({ type: "tool-result" }) }),
      ]),
    );

    expect(converted.latestUserMessage?.role).toBe("user");
    expect(
      converted.history.some((msg) =>
        (msg.parts ?? []).some((part) => part.kind === "text" && (part as { text?: string }).text?.includes("Follow project guidelines")),
      ),
    ).toBe(false);
  });

  it("optionally forwards system and developer messages when enabled", () => {
    const converted = convertAGUIMessagesToA2A(
      [
        createMessage({ id: "sys-1", role: "system", content: "sys" }),
        createMessage({ id: "dev-1", role: "developer", content: "dev" }),
        createMessage({ id: "user-1", role: "user", content: "user content" }),
      ],
      { includeSystemMessages: true, includeDeveloperMessages: true },
    );

    expect(converted.history).toHaveLength(3);
    const systemEntry = converted.history.find((entry) => entry.messageId === "sys-1");
    expect(systemEntry?.role).toBe("user");
    expect(systemEntry?.metadata).toEqual(expect.objectContaining({ originalRole: "system" }));
  });

  it("adds Engram extension and payload when provided", () => {
    const converted = convertAGUIMessagesToA2A(
      [createMessage({ id: "user-1", role: "user", content: "configure" })],
      {
        engramUpdate: { scope: "task", update: { path: "/config", value: "x" } },
      },
    );

    const target = converted.targetMessage!;
    expect(target.extensions).toContain(ENGRAM_EXTENSION_URI);
    const engramPart = target.parts.find((part) => part.kind === "data") as
      | { kind: "data"; data?: { scope?: string } }
      | undefined;
    expect(engramPart?.data?.scope).toBe("task");
  });

  it("preserves full history and context metadata for streaming payloads", () => {
    const context = [{ description: "region", value: "us-west-2" }];
    const converted = convertAGUIMessagesToA2A(
      [
        createMessage({ id: "sys-1", role: "system", content: "Guardrails" }),
        createMessage({ id: "dev-1", role: "developer", content: "Dev hints" }),
        createMessage({ id: "user-1", role: "user", content: "Question A" }),
        createMessage({ id: "assistant-1", role: "assistant", content: "Interim answer" }),
        createMessage({ id: "user-2", role: "user", content: "Question B" }),
      ],
      {
        includeSystemMessages: true,
        includeDeveloperMessages: true,
        contextId: "ctx-a2a",
        taskId: "task-a2a",
        context,
      },
    );

    const metadataHistory = (converted.metadata?.history ?? []) as Array<{ messageId?: string }>;
    const historyIds = metadataHistory.map((entry) => entry.messageId);

    expect(converted.contextId).toBe("ctx-a2a");
    expect(converted.taskId).toBe("task-a2a");
    expect(converted.metadata?.context).toEqual(context);
    expect(metadataHistory.length).toBe(5);
    expect(historyIds).toEqual(
      expect.arrayContaining(["sys-1", "dev-1", "user-1", "assistant-1", "user-2"]),
    );
    expect(converted.latestUserMessage?.messageId).toBe("user-2");
    expect(converted.targetMessage?.extensions ?? []).toHaveLength(0);
  });
});

describe("convertA2AEventToAGUIEvents", () => {
  it("produces AG-UI text chunks from A2A messages", () => {
    const a2aEvent = {
      kind: "message" as const,
      messageId: "remote-1",
      role: "agent" as const,
      parts: [
        { kind: "text" as const, text: "Hello from A2A" },
      ],
    };

    const map = new Map<string, string>();
    const events = convertA2AEventToAGUIEvents(a2aEvent, {
      messageIdMap: map,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: EventType.TEXT_MESSAGE_CHUNK,
        delta: "Hello from A2A",
      }),
    );

    expect(map.size).toBe(1);
  });

  it("maps tool-call payloads to tool events", () => {
    const a2aEvent = {
      kind: "message" as const,
      messageId: "remote-call",
      role: "agent" as const,
      parts: [
        {
          kind: "data" as const,
          data: { type: "tool-call", id: "tool-123", name: "lookup", arguments: { query: "hi" } },
        },
        {
          kind: "data" as const,
          data: { type: "tool-result", toolCallId: "tool-123", payload: { ok: true } },
        },
      ],
    };

    const events = convertA2AEventToAGUIEvents(a2aEvent, { messageIdMap: new Map() });

    expect(events).toEqual([
      expect.objectContaining({ type: EventType.TOOL_CALL_START, toolCallId: "tool-123" }),
      expect.objectContaining({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tool-123" }),
      expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, toolCallId: "tool-123" }),
      expect.objectContaining({ type: EventType.TOOL_CALL_END, toolCallId: "tool-123" }),
    ]);
  });

  it("maps tool-result payloads to ToolCallResult events", () => {
    const a2aEvent = {
      kind: "message" as const,
      messageId: "remote-2",
      role: "agent" as const,
      parts: [
        {
          kind: "data" as const,
          data: { type: "tool-result", toolCallId: "call-1", payload: { ok: true } },
        },
      ],
    };

    const events = convertA2AEventToAGUIEvents(a2aEvent, { messageIdMap: new Map() });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "call-1",
      }),
    );
  });

  it("projects artifact updates into shared state", () => {
    const tracker = createSharedStateTracker();
    const artifactEvent = {
      kind: "artifact-update" as const,
      contextId: "ctx",
      taskId: "task-1",
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: "artifact-1",
        parts: [{ kind: "data" as const, data: { foo: "bar" } }],
      },
    };

    const events = convertA2AEventToAGUIEvents(artifactEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
      artifactBasePath: DEFAULT_ARTIFACT_BASE_PATH,
    });

    const stateEvent = events.find((event) => event.type === EventType.STATE_DELTA) as {
      delta?: Array<{ path?: string; value?: unknown }>;
    };

    expect(stateEvent?.delta?.[0]?.path).toBe("/view/artifacts/artifact-1");
    expect(
      (tracker.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-1"
      ],
    ).toEqual({ foo: "bar" });
  });

  it("appends streamed artifact text when append is true", () => {
    const tracker = createSharedStateTracker({
      view: { artifacts: { "artifact-append": "Hello" } },
    });
    const artifactEvent = {
      kind: "artifact-update" as const,
      contextId: "ctx",
      taskId: "task-append",
      append: true,
      lastChunk: false,
      artifact: {
        artifactId: "artifact-append",
        parts: [{ kind: "text" as const, text: " World" }],
      },
    };

    const events = convertA2AEventToAGUIEvents(artifactEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
      artifactBasePath: DEFAULT_ARTIFACT_BASE_PATH,
    });

    const stateEvent = events.find(
      (event) => event.type === EventType.STATE_DELTA,
    ) as StateDeltaEvent | undefined;

    expect(stateEvent?.delta?.[0]?.value).toBe("Hello World");
    expect(
      (tracker.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-append"
      ],
    ).toBe("Hello World");
  });

  it("routes artifacts to metadata-provided paths", () => {
    const tracker = createSharedStateTracker();
    const artifactEvent = {
      kind: "artifact-update" as const,
      contextId: "ctx",
      taskId: "task-custom-path",
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: "artifact-99",
        metadata: { path: "/view/config" },
        parts: [{ kind: "data" as const, data: { feature: "enabled" } }],
      },
    };

    const events = convertA2AEventToAGUIEvents(artifactEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
    });

    const stateEvent = events.find(
      (event) => event.type === EventType.STATE_DELTA,
    ) as StateDeltaEvent | undefined;

    expect(stateEvent?.delta?.[0]?.path).toBe("/view/config");
    expect(
      (tracker.state as { view?: { config?: unknown } }).view?.config,
    ).toEqual({ feature: "enabled" });
  });

  it("projects status updates into shared state when a tracker is present", () => {
    const tracker = createSharedStateTracker();
    const statusEvent = {
      kind: "status-update" as const,
      contextId: "ctx",
      final: false,
      status: { state: "working" as const, message: undefined, timestamp: "now" },
      taskId: "task-2",
    };

    const events = convertA2AEventToAGUIEvents(statusEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
    });

    expect(events.some((event) => event.type === EventType.STATE_DELTA)).toBe(true);
    expect(
      (tracker.state as { view?: { tasks?: Record<string, unknown> } }).view?.tasks?.["task-2"],
    ).toEqual(
      expect.objectContaining({
        status: expect.objectContaining({ state: "working" }),
      }),
    );
  });

  it("emits status message chunks while projecting status into shared state", () => {
    const tracker = createSharedStateTracker();
    const statusEvent = {
      kind: "status-update" as const,
      contextId: "ctx",
      final: false,
      status: {
        state: "pending" as const,
        message: {
          kind: "message" as const,
          messageId: "status-msg",
          role: "agent" as const,
          parts: [{ kind: "text" as const, text: "Provisioning" }],
        },
        timestamp: "later",
      },
      taskId: "task-status",
    };

    const events = convertA2AEventToAGUIEvents(statusEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
    });

    const textEvent = events.find(
      (event) => event.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as TextMessageChunkEvent | undefined;
    const stateEvent = events.find(
      (event) => event.type === EventType.STATE_DELTA,
    ) as StateDeltaEvent | undefined;

    expect(textEvent?.delta).toBe("Provisioning");
    expect(stateEvent?.delta?.[0]?.path).toBe("/view/tasks/task-status/status");
    expect(
      (tracker.state as { view?: { tasks?: Record<string, unknown> } }).view?.tasks?.[
        "task-status"
      ],
    ).toEqual(
      expect.objectContaining({
        status: expect.objectContaining({ state: "pending" }),
      }),
    );
  });

  it("maps task status updates to raw events", () => {
    const statusEvent = {
      kind: "status-update" as const,
      contextId: "ctx",
      final: false,
      status: { state: "working", message: undefined },
      taskId: "task-1",
    };

    const events = convertA2AEventToAGUIEvents(
      statusEvent as unknown as import("@a2a-js/sdk").TaskStatusUpdateEvent,
      {
        messageIdMap: new Map(),
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(EventType.RAW);
  });
});

describe("sendMessageToA2AAgentTool", () => {
  it("matches the expected schema", () => {
    expect(sendMessageToA2AAgentTool.name).toBe("send_message_to_a2a_agent");
    expect(sendMessageToA2AAgentTool.parameters.required).toContain("task");
  });
});
