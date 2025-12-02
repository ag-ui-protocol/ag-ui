import { EventType } from "@ag-ui/client";
import type { Message, StateDeltaEvent, StateSnapshotEvent, TextMessageChunkEvent } from "@ag-ui/client";
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

  it("skips developer messages by default while keeping user history intact", () => {
    const converted = convertAGUIMessagesToA2A([
      createMessage({ id: "dev-1", role: "developer", content: "internal hint" }),
      createMessage({ id: "user-1", role: "user", content: "visible input" }),
    ]);

    const historyIds = converted.history.map((entry) => entry.messageId);
    expect(historyIds).toEqual(expect.arrayContaining(["user-1"]));
    expect(historyIds).not.toEqual(expect.arrayContaining(["dev-1"]));
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

  it("attaches Engram metadata while preserving conversational history", () => {
    const engramUpdate = {
      scope: "context" as const,
      path: "/config/features",
      update: { feature: "a2a-streaming", enabled: true },
    };

    const converted = convertAGUIMessagesToA2A(
      [
        createMessage({ id: "user-1", role: "user", content: "Adjust settings" }),
        createMessage({ id: "assistant-1", role: "assistant", content: "Working on it" }),
      ],
      {
        engramUpdate,
        contextId: "ctx-engram",
        taskId: "task-engram",
      },
    );

    const target = converted.targetMessage!;
    const engramPart = target.parts.find((part) => part.kind === "data") as
      | { kind: "data"; data?: Record<string, unknown> }
      | undefined;

    expect(converted.metadata?.engram).toEqual(engramUpdate);
    expect(converted.metadata?.history).toHaveLength(3);
    expect(target.extensions).toContain(ENGRAM_EXTENSION_URI);
    expect(engramPart?.data).toEqual(
      expect.objectContaining({
        type: "engram",
        scope: "context",
        path: "/config/features",
        update: { feature: "a2a-streaming", enabled: true },
      }),
    );
    expect(
      converted.history.some(
        (message) => message.messageId === "assistant-1" && message.role === "agent",
      ),
    ).toBe(true);
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

  it("keeps the conversational lane when Engram updates are absent", () => {
    const converted = convertAGUIMessagesToA2A([
      createMessage({ id: "user-1", role: "user", content: "hello" }),
    ]);

    expect(converted.metadata?.engram).toBeUndefined();
    expect(converted.targetMessage?.extensions ?? []).toHaveLength(0);
  });

  it("appends form response payloads when resume metadata is provided", () => {
    const converted = convertAGUIMessagesToA2A(
      [createMessage({ id: "user-1", role: "user", content: "resume" })],
      {
        contextId: "ctx-hitl",
        taskId: "task-hitl",
        resume: { interruptId: "hitl-task-hitl-1", payload: { field: "value" } },
      },
    );

    const target = converted.targetMessage!;
    const dataParts = (target.parts ?? []).filter((part) => part.kind === "data") as Array<{
      data?: Record<string, unknown>;
    }>;
    const formResponse = dataParts.find((part) => part.data?.type === "a2a.hitl.formResponse")?.data;

    expect(formResponse).toEqual(
      expect.objectContaining({
        interruptId: "hitl-task-hitl-1",
        values: { field: "value" },
      }),
    );
    expect(target.contextId).toBe("ctx-hitl");
    expect(target.taskId).toBe("task-hitl");
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

    const targetPatch = stateEvent?.delta?.find(
      (entry) => entry.path === "/view/artifacts/artifact-1",
    );
    expect(targetPatch?.path).toBe("/view/artifacts/artifact-1");
    expect(
      (tracker.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-1"
      ],
    ).toEqual({ foo: "bar" });
  });

  it("emits text chunks and snapshot projections for non-appending text artifacts", () => {
    const tracker = createSharedStateTracker({
      view: { artifacts: { "artifact-snapshot": "Old value" } },
    });
    const artifactEvent = {
      kind: "artifact-update" as const,
      contextId: "ctx",
      taskId: "task-snapshot",
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: "artifact-snapshot",
        parts: [{ kind: "text" as const, text: "Fresh value" }],
      },
    };

    const events = convertA2AEventToAGUIEvents(artifactEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
      artifactBasePath: DEFAULT_ARTIFACT_BASE_PATH,
    });

    expect(
      events.some(
        (event) =>
          event.type === EventType.TEXT_MESSAGE_CHUNK &&
          (event as { delta?: unknown }).delta === "Fresh value",
      ),
    ).toBe(true);

    const stateEvent = events.find((event) => event.type === EventType.STATE_DELTA) as
      | StateDeltaEvent
      | undefined;
    const delta = stateEvent?.delta?.[0];

    expect(delta?.path).toBe("/view/artifacts/artifact-snapshot");
    expect(delta?.value).toBe("Fresh value");
    expect(
      (tracker.state as { view?: { artifacts?: Record<string, unknown> } }).view?.artifacts?.[
        "artifact-snapshot"
      ],
    ).toBe("Fresh value");
  });

  it("emits legacy text-only agent output without shared-state projections when Engram is absent", () => {
    const textOnlyEvent = {
      kind: "message" as const,
      messageId: "legacy-1",
      role: "agent" as const,
      parts: [{ kind: "text" as const, text: "Plain response" }],
    };

    const events = convertA2AEventToAGUIEvents(textOnlyEvent, { messageIdMap: new Map() });

    expect(
      events.filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK && event.delta === "Plain response"),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === EventType.STATE_DELTA)).toBe(false);
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

  it("appends structured artifact data to arrays for streaming updates", () => {
    const tracker = createSharedStateTracker({
      view: { artifacts: { "artifact-stream": [{ chunk: 1 }] } },
    });
    const artifactEvent = {
      kind: "artifact-update" as const,
      contextId: "ctx",
      taskId: "task-stream",
      append: true,
      lastChunk: false,
      artifact: {
        artifactId: "artifact-stream",
        parts: [{ kind: "data" as const, data: { chunk: 2 } }],
      },
    };

    const events = convertA2AEventToAGUIEvents(artifactEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
      artifactBasePath: DEFAULT_ARTIFACT_BASE_PATH,
    });

    const stateEvent = events.find((event) => event.type === EventType.STATE_DELTA) as
      | StateDeltaEvent
      | undefined;
    const delta = stateEvent?.delta?.[0];

    expect(delta).toEqual(
      expect.objectContaining({
        op: "add",
        path: "/view/artifacts/artifact-stream/-",
        value: { chunk: 2 },
      }),
    );
    expect(
      (tracker.state as { view?: { artifacts?: Record<string, unknown>[] } }).view?.artifacts?.[
        "artifact-stream"
      ],
    ).toEqual([{ chunk: 1 }, { chunk: 2 }]);
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

    const targetPatch = stateEvent?.delta?.find((entry) => entry.path === "/view/config");
    expect(targetPatch?.path).toBe("/view/config");
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
      taskId: "task-with-status",
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
    const targetPatch = stateEvent?.delta?.find(
      (entry) => entry.path === "/view/tasks/task-with-status/status",
    );
    expect(targetPatch?.path).toBe("/view/tasks/task-with-status/status");
    expect(
      (tracker.state as { view?: { tasks?: Record<string, unknown> } }).view?.tasks?.[
        "task-with-status"
      ],
    ).toEqual(
      expect.objectContaining({
        status: expect.objectContaining({ state: "pending" }),
      }),
    );
  });

  it("emits HITL interrupt activity, state projection, and run finish payloads", () => {
    const tracker = createSharedStateTracker();
    const statusEvent = {
      kind: "status-update" as const,
      contextId: "ctx-hitl",
      final: false,
      status: {
        state: "input-required" as const,
        message: {
          kind: "message" as const,
          messageId: "status-hitl",
          role: "agent" as const,
          parts: [
            { kind: "text" as const, text: "Need approval" },
            { kind: "data" as const, data: { type: "a2a.hitl.form", formId: "form-123", fields: [] } },
          ],
        },
        timestamp: "soon",
      },
      taskId: "task-hitl",
    };

    const events = convertA2AEventToAGUIEvents(statusEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
      threadId: "thread-hitl",
      runId: "run-hitl",
    });

    const runFinished = events.find((event) => event.type === EventType.RUN_FINISHED) as {
      result?: Record<string, unknown>;
    };
    const activitySnapshot = events.find(
      (event) => event.type === EventType.ACTIVITY_SNAPSHOT,
    ) as { messageId?: string; activityType?: string };
    const pendingInterrupts = (tracker.state as {
      view?: { pendingInterrupts?: Record<string, unknown> };
    }).view?.pendingInterrupts;

    expect(activitySnapshot?.activityType).toBe("HITL_FORM");
    expect(runFinished?.result).toEqual(
      expect.objectContaining({
        outcome: "interrupt",
        taskId: "task-hitl",
        interruptId: activitySnapshot?.messageId,
      }),
    );
    expect(runFinished?.result?.contextId).toBe("ctx-hitl");
    expect(pendingInterrupts?.[activitySnapshot?.messageId ?? ""]).toEqual(
      expect.objectContaining({ taskId: "task-hitl", formId: "form-123" }),
    );
  });

  it("generates monotonic interruptIds and includes form payloads in RUN_FINISHED results", () => {
    const tracker = createSharedStateTracker();
    const options = {
      messageIdMap: new Map<string, string>(),
      sharedStateTracker: tracker,
      threadId: "thread-hitl",
      runId: "run-hitl",
    };

    const firstInterrupt = {
      kind: "status-update" as const,
      contextId: "ctx-hitl",
      final: false,
      status: {
        state: "input-required" as const,
        message: {
          kind: "message" as const,
          messageId: "status-hitl-1",
          role: "agent" as const,
          parts: [
            { kind: "text" as const, text: "Need approval" },
            { kind: "data" as const, data: { type: "a2a.hitl.form", formId: "form-1", fields: [] } },
          ],
        },
      },
      taskId: "task-hitl",
    };

    const firstEvents = convertA2AEventToAGUIEvents(firstInterrupt, options);
    const firstRunFinished = firstEvents.find(
      (event) => event.type === EventType.RUN_FINISHED,
    ) as { result?: Record<string, unknown> };

    expect(firstRunFinished?.result).toEqual(
      expect.objectContaining({
        outcome: "interrupt",
        taskId: "task-hitl",
        contextId: "ctx-hitl",
        interruptId: "hitl-task-hitl-1",
        form: expect.objectContaining({ formId: "form-1" }),
      }),
    );

    const formResponse = {
      kind: "message" as const,
      messageId: "resume-msg",
      role: "user" as const,
      contextId: "ctx-hitl",
      taskId: "task-hitl",
      parts: [{ kind: "data" as const, data: { type: "a2a.hitl.formResponse", values: { choice: "ok" } } }],
    };
    convertA2AEventToAGUIEvents(formResponse, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
    });

    const secondInterrupt = {
      ...firstInterrupt,
      status: {
        ...firstInterrupt.status,
        message: {
          ...(firstInterrupt.status?.message as { [key: string]: unknown }),
          messageId: "status-hitl-2",
          parts: [
            { kind: "text" as const, text: "Need another approval" },
            { kind: "data" as const, data: { type: "a2a.hitl.form", formId: "form-2", fields: [] } },
          ],
        },
      },
    };

    const secondEvents = convertA2AEventToAGUIEvents(secondInterrupt, options);
    const secondRunFinished = secondEvents.find(
      (event) => event.type === EventType.RUN_FINISHED,
    ) as { result?: Record<string, unknown> };

    expect(secondRunFinished?.result).toEqual(
      expect.objectContaining({
        interruptId: "hitl-task-hitl-2",
        form: expect.objectContaining({ formId: "form-2" }),
      }),
    );
  });

  it("clears pending interrupts and emits activity delta on HITL form responses", () => {
    const tracker = createSharedStateTracker();
    const statusEvent = {
      kind: "status-update" as const,
      contextId: "ctx-hitl",
      final: false,
      status: {
        state: "input-required" as const,
        message: {
          kind: "message" as const,
          messageId: "status-hitl",
          role: "agent" as const,
          parts: [
            { kind: "text" as const, text: "Need approval" },
            { kind: "data" as const, data: { type: "a2a.hitl.form", formId: "form-123" } },
          ],
        },
      },
      taskId: "task-hitl",
    };

    convertA2AEventToAGUIEvents(statusEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
      threadId: "thread-hitl",
      runId: "run-hitl",
    });

    const responseEvent = {
      kind: "message" as const,
      messageId: "resume-msg",
      role: "user" as const,
      contextId: "ctx-hitl",
      taskId: "task-hitl",
      parts: [{ kind: "data" as const, data: { type: "a2a.hitl.formResponse", values: { choice: "ok" } } }],
    };

    const events = convertA2AEventToAGUIEvents(responseEvent, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
    });

    const activityDelta = events.find(
      (event) => event.type === EventType.ACTIVITY_DELTA,
    ) as { patch?: Array<{ path?: string; value?: unknown }> };
    const stateDelta = events.find(
      (event) => event.type === EventType.STATE_DELTA,
    ) as StateDeltaEvent | undefined;

    expect(
      activityDelta?.patch?.some((entry) => entry.path === "/stage" && entry.value === "working"),
    ).toBe(true);
    expect(
      stateDelta?.delta?.some((entry) => entry.op === "remove" && `${entry.path}`.includes("/view/pendingInterrupts")),
    ).toBe(true);
    expect((tracker.state as { view?: { pendingInterrupts?: Record<string, unknown> } }).view?.pendingInterrupts).toEqual(
      {},
    );
  });

  it("projects surface operations into activity events and de-duplicates snapshots", () => {
    const seenSurfaceIds = new Set<string>();
    const surfaceTracker = {
      has: (surfaceId: string) => seenSurfaceIds.has(surfaceId),
      add: (surfaceId: string) => {
        seenSurfaceIds.add(surfaceId);
      },
    };

    const surfaceOperation = {
      surfaceUpdate: {
        surfaceId: "surface-123",
        payload: { html: "<div>render</div>" },
      },
    };

    const surfaceEvent = {
      kind: "message" as const,
      messageId: "surface-msg",
      role: "agent" as const,
      parts: [{ kind: "data" as const, data: surfaceOperation }],
    };

    const firstPass = convertA2AEventToAGUIEvents(surfaceEvent, {
      messageIdMap: new Map(),
      surfaceTracker,
    });
    const snapshot = firstPass.find((event) => event.type === EventType.ACTIVITY_SNAPSHOT);
    const delta = firstPass.find((event) => event.type === EventType.ACTIVITY_DELTA) as
      | { patch?: Array<{ path?: string; value?: unknown }> }
      | undefined;

    expect(snapshot).toBeDefined();
    expect(delta?.patch?.[0]?.path).toBe("/operations/-");
    expect(delta?.patch?.[0]?.value).toEqual(surfaceOperation);

    const secondPass = convertA2AEventToAGUIEvents(surfaceEvent, {
      messageIdMap: new Map(),
      surfaceTracker,
    });

    expect(secondPass.some((event) => event.type === EventType.ACTIVITY_SNAPSHOT)).toBe(false);
    expect(secondPass.some((event) => event.type === EventType.ACTIVITY_DELTA)).toBe(true);
  });

  it("replays task snapshots by emitting task state and full message history for audit consistency", () => {
    const tracker = createSharedStateTracker();
    const taskSnapshot = {
      kind: "task" as const,
      id: "task-history",
      contextId: "ctx-audit",
      status: { state: "working" as const },
      history: [
        {
          kind: "message" as const,
          messageId: "hist-1",
          role: "agent" as const,
          parts: [{ kind: "text" as const, text: "First output" }],
        },
        {
          kind: "message" as const,
          messageId: "hist-2",
          role: "agent" as const,
          parts: [{ kind: "text" as const, text: "Second output" }],
        },
      ],
      artifacts: [],
    };

    const events = convertA2AEventToAGUIEvents(taskSnapshot, {
      messageIdMap: new Map(),
      sharedStateTracker: tracker,
    });

    const stateSnapshot = events.find(
      (event) => event.type === EventType.STATE_SNAPSHOT,
    ) as StateSnapshotEvent | undefined;
    const textChunks = events.filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK);

    expect(
      (stateSnapshot?.snapshot as { view?: { tasks?: Record<string, unknown> } }).view?.tasks?.[
        "task-history"
      ],
    ).toEqual(
      expect.objectContaining({
        taskId: "task-history",
        contextId: "ctx-audit",
        status: expect.objectContaining({ state: "working" }),
      }),
    );
    expect(
      textChunks.map((event) => (event as { delta?: unknown }).delta),
    ).toEqual(expect.arrayContaining(["First output", "Second output"]));
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
