import {
  EventType,
  type AGUIEvent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import {
  Agent,
  BaseAgent,
  BaseLlm,
  FunctionTool,
  InMemorySessionService,
  Runner,
  createEvent,
  type BaseLlmConnection,
  type Event as AdkEvent,
  type InvocationContext,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import {
  ADKEventError,
  ADKEventTranslator,
  ADKAgent,
  AGUIClientToolset,
  getPendingUserInputRequests,
} from "../index";
import { convertMessage } from "../message-converter";

type Script = (
  context: InvocationContext,
) => readonly AdkEvent[] | Promise<readonly AdkEvent[]>;

class ScriptedAgent extends BaseAgent {
  constructor(private readonly script: Script) {
    super({ name: "scripted_agent" });
  }

  protected override async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    for (const event of await this.script(context)) {
      yield event;
    }
  }

  protected override async *runLiveImpl(): AsyncGenerator<
    AdkEvent,
    void,
    void
  > {
    return;
  }
}

class DeterministicLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: readonly LlmResponse[]) {
    super({ model: "deterministic-test-model" });
  }

  get callCount(): number {
    return this.responseIndex;
  }

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const response = this.responses[this.responseIndex++];
    if (!response) {
      throw new Error("DeterministicLlm ran out of responses.");
    }
    yield response;
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error("DeterministicLlm does not support live mode.");
  }
}

function runInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [{ id: "user-1", role: "user", content: "Hello" }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

async function collect(
  agent: ADKAgent,
  input: RunAgentInput,
): Promise<AGUIEvent[]> {
  return lastValueFrom(agent.run(input).pipe(toArray()));
}

function textEvent(params: {
  id: string;
  text: string;
  partial?: boolean;
  thought?: boolean;
}): AdkEvent {
  return createEvent({
    id: params.id,
    author: "scripted_agent",
    partial: params.partial,
    content: {
      role: "model",
      parts: [{ text: params.text, thought: params.thought }],
    },
  });
}

describe("ADKEventTranslator", () => {
  it("streams text once when ADK repeats the aggregate final response", () => {
    const translator = new ADKEventTranslator({ count: 0 });
    const events = [
      ...translator.translate(
        textEvent({ id: "p1", text: "Hel", partial: true }),
      ),
      ...translator.translate(
        textEvent({ id: "p2", text: "lo", partial: true }),
      ),
      ...translator.translate(textEvent({ id: "final", text: "Hello" })),
    ];

    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta),
    ).toEqual(["Hel", "lo"]);
    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
  });

  it("maps reasoning, state, usage, tools, and raw parts", () => {
    const translator = new ADKEventTranslator({ count: 0 });
    const thought = textEvent({ id: "thought", text: "check", thought: true });
    thought.content!.parts![0].thoughtSignature = "opaque-signature";
    const state = createEvent({
      id: "state",
      author: "scripted_agent",
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
        thoughtsTokenCount: 1,
        cachedContentTokenCount: 1,
      },
    });
    state.actions.stateDelta = {
      count: 1,
      "a/b": true,
      _ag_ui_context: [],
      "app:shared": "private",
      "user:profile": "private",
      "temp:working": "private",
    };
    const tool = createEvent({
      id: "tool",
      author: "scripted_agent",
      content: {
        role: "model",
        parts: [
          { functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } },
          { executableCode: { language: "PYTHON" as never, code: "print(1)" } },
        ],
      },
    });

    const events = [
      ...translator.translate(thought),
      ...translator.translate(state),
      ...translator.translate(tool),
      ...translator.finish(),
    ];

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_ENCRYPTED_VALUE,
        EventType.STATE_DELTA,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.RAW,
      ]),
    );
    const delta = events.find((event) => event.type === EventType.STATE_DELTA);
    expect(delta?.delta).toEqual([
      { op: "replace", path: "/count", value: 1 },
      { op: "add", path: "/a~1b", value: true },
    ]);
    expect(translator.getState()).toEqual({ count: 1, "a/b": true });
    expect(translator.getUsage()).toEqual([
      {
        provider: "google",
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        reasoningTokens: 1,
        cachedInputTokens: 1,
      },
    ]);
  });

  it("waits for the complete call during progressive function-call streaming", () => {
    const translator = new ADKEventTranslator({});
    const partialText = textEvent({
      id: "partial-text",
      text: "Working",
      partial: true,
    });
    const partialCall = createEvent({
      id: "partial-call",
      author: "scripted_agent",
      partial: true,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "call-1",
              name: "lookup",
              args: { partial: "fragment" },
            },
          },
        ],
      },
    });
    const final = createEvent({
      id: "final-call",
      author: "scripted_agent",
      content: {
        role: "model",
        parts: [
          { text: "Working" },
          {
            functionCall: {
              id: "call-1",
              name: "lookup",
              args: { complete: true },
            },
          },
        ],
      },
    });

    const events = [
      ...translator.translate(partialText),
      ...translator.translate(partialCall),
      ...translator.translate(final),
    ];

    expect(
      events
        .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta),
    ).toEqual(["Working"]);
    expect(
      events
        .filter((event) => event.type === EventType.TOOL_CALL_ARGS)
        .map((event) => event.delta),
    ).toEqual(['{"complete":true}']);
  });

  it("raises an ADKEventError for an ADK error event", () => {
    const translator = new ADKEventTranslator({});
    expect(() =>
      translator.translate(
        createEvent({ errorCode: "MODEL_ERROR", errorMessage: "model failed" }),
      ),
    ).toThrow(ADKEventError);
  });
});

describe("ADK interrupt compatibility", () => {
  it("finds input, credential, and confirmation requests and removes answers", () => {
    const requested = createEvent({
      author: "scripted_agent",
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "input-1",
              name: "adk_request_input",
              args: {
                message: "Pick one",
                response_schema: { type: "string", enum: ["a", "b"] },
              },
            },
          },
          {
            functionCall: {
              id: "credential-1",
              name: "adk_request_credential",
              args: { auth_config: { type: "apiKey" } },
            },
          },
          {
            functionCall: {
              id: "confirmation-1",
              name: "adk_request_confirmation",
              args: {
                originalFunctionCall: { name: "delete_record" },
                toolConfirmation: { hint: "Proceed?", payload: { id: 7 } },
              },
            },
          },
        ],
      },
    });
    const answered = createEvent({
      author: "user",
      content: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "credential-1",
              name: "adk_request_credential",
              response: { token: "secret" },
            },
          },
        ],
      },
    });

    const pending = getPendingUserInputRequests([requested, answered]);
    expect(pending.map((request) => request.kind)).toEqual([
      "input",
      "confirmation",
    ]);
    expect(pending[0]).toMatchObject({
      interruptId: "input-1",
      message: "Pick one",
      responseSchema: { type: "string", enum: ["a", "b"] },
    });
    expect(pending[1]).toMatchObject({
      interruptId: "confirmation-1",
      message: "Proceed?",
      toolName: "delete_record",
      payload: { id: 7 },
    });
  });
});

describe("AGUIClientToolset", () => {
  it("keeps arbitrary JSON Schema and scopes bindings by user and session", async () => {
    const toolset = new AGUIClientToolset();
    const schema = {
      type: "object",
      $defs: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
      properties: { value: { $ref: "#/$defs/value" } },
    };
    toolset.bindTools("user-a", "thread-a", [
      {
        name: "client_action",
        description: "Runs in the UI",
        parameters: schema,
      },
    ]);

    const tools = await toolset.getTools({
      userId: "user-a",
      sessionId: "thread-a",
    } as never);
    expect(tools).toHaveLength(1);
    expect(tools[0].isLongRunning).toBe(true);
    expect(tools[0]._getDeclaration()).toMatchObject({
      name: "client_action",
      parametersJsonSchema: schema,
    });
    expect(
      await tools[0].runAsync({ args: { value: 1 }, toolContext: {} as never }),
    ).toBeUndefined();

    await toolset.close();
    expect(
      await toolset.getTools({
        userId: "user-a",
        sessionId: "thread-a",
      } as never),
    ).toHaveLength(1);
    expect(
      await toolset.getTools({
        userId: "user-b",
        sessionId: "thread-a",
      } as never),
    ).toHaveLength(0);
    toolset.unbindTools("user-a", "thread-a");
    expect(
      await toolset.getTools({
        userId: "user-a",
        sessionId: "thread-a",
      } as never),
    ).toHaveLength(0);
  });
});

describe("AG-UI to ADK message conversion", () => {
  it("preserves text and multimodal user parts", () => {
    const message: Message = {
      id: "user-multimodal",
      role: "user",
      content: [
        { type: "text", text: "Describe these" },
        {
          type: "image",
          source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" },
        },
        {
          type: "audio",
          source: {
            type: "url",
            value: "gs://bucket/audio.wav",
            mimeType: "audio/wav",
          },
        },
        {
          type: "document",
          source: {
            type: "url",
            value: "gs://bucket/file.pdf",
            mimeType: "application/pdf",
          },
        },
      ],
    };

    expect(convertMessage(message, [message], "model")).toEqual({
      author: "user",
      content: {
        role: "user",
        parts: [
          { text: "Describe these" },
          { inlineData: { data: "aW1hZ2U=", mimeType: "image/png" } },
          {
            fileData: {
              fileUri: "gs://bucket/audio.wav",
              mimeType: "audio/wav",
            },
          },
          {
            fileData: {
              fileUri: "gs://bucket/file.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
      },
    });
  });

  it("rejects dynamic instructions instead of downgrading them to user text", () => {
    const message: Message = {
      id: "system-1",
      role: "system",
      content: "Override the ADK instruction",
    };
    expect(() => convertMessage(message, [message], "model")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_MESSAGE_ROLE" }),
    );
  });

  it("rejects malformed tool arguments instead of changing their shape", () => {
    const message: Message = {
      id: "assistant-1",
      role: "assistant",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "lookup", arguments: "{not-json" },
        },
      ],
    };
    expect(() => convertMessage(message, [message], "model")).toThrowError(
      expect.objectContaining({ code: "INVALID_TOOL_ARGUMENTS" }),
    );
  });

  it("does not inject activity messages into model history", () => {
    const message: Message = {
      id: "activity-1",
      role: "activity",
      activityType: "ui.navigation",
      content: { route: "/settings" },
    };
    expect(convertMessage(message, [message], "model")).toBeUndefined();
  });

  it("rejects unresolved binary attachment IDs instead of fabricating model text", () => {
    const message: Message = {
      id: "user-binary",
      role: "user",
      content: [
        {
          type: "binary",
          id: "artifact-only",
          mimeType: "application/octet-stream",
        },
      ],
    };
    expect(() => convertMessage(message, [message], "model")).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_BINARY_REFERENCE" }),
    );
  });
});

describe("ADKAgent", () => {
  it("preserves ADK configuration across CopilotKit request clones", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => [
        textEvent({ id: "clone-answer", text: "cloned" }),
      ]),
      sessionService: new InMemorySessionService(),
    });
    const original = new ADKAgent({ runner, userId: "user-1" });
    const cloned = original.clone();
    cloned.threadId = "clone-thread";
    cloned.messages = [{ id: "clone-user", role: "user", content: "Hello" }];
    cloned.state = { source: "clone" };
    // AbstractAgent.runAgent exposes its subscriber at the base protocol type.
    const events: BaseEvent[] = [];

    await cloned.runAgent(
      { runId: "clone-run" },
      { onEvent: ({ event }) => void events.push(event) },
    );

    expect(cloned).toBeInstanceOf(ADKAgent);
    expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("advertises only bridge-known capabilities unless explicitly configured", async () => {
    const runner = new Runner({
      appName: "test-app",
      agent: new ScriptedAgent(() => []),
      sessionService: new InMemorySessionService(),
    });
    const conservative = await new ADKAgent({
      runner,
      userId: "user-1",
    }).getCapabilities();

    expect(conservative.tools).toMatchObject({
      supported: true,
      parallelCalls: false,
    });
    expect(conservative.reasoning).toBeUndefined();
    expect(conservative.multimodal).toBeUndefined();

    const declared = await new ADKAgent({
      runner,
      userId: "user-1",
      capabilities: {
        tools: { parallelCalls: true },
        reasoning: { supported: true, streaming: true },
        multimodal: { input: { image: true } },
      },
    }).getCapabilities();
    expect(declared.tools).toMatchObject({
      supported: true,
      parallelCalls: true,
    });
    expect(declared.reasoning).toEqual({ supported: true, streaming: true });
    expect(declared.multimodal).toEqual({ input: { image: true } });

    const factoryCapabilities = await new ADKAgent({
      runnerFactory: () => runner,
      userId: "user-1",
    }).getCapabilities();
    expect(factoryCapabilities.tools).not.toHaveProperty("clientProvided");
    expect(factoryCapabilities.state).not.toHaveProperty("persistentState");

    const explicitEmptyToolsets = await new ADKAgent({
      runnerFactory: () => runner,
      clientToolsets: [],
      userId: "user-1",
    }).getCapabilities();
    expect(explicitEmptyToolsets.tools).toHaveProperty("clientProvided", false);
  });

  it("surfaces unsupported instruction history as a protocol error", async () => {
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        agent: new ScriptedAgent(() => []),
        sessionService: new InMemorySessionService(),
      }),
      userId: "user-1",
    });
    const events = await collect(
      bridge,
      runInput({
        messages: [
          { id: "system-1", role: "system", content: "Dynamic instruction" },
          { id: "user-1", role: "user", content: "Hello" },
        ],
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "UNSUPPORTED_MESSAGE_ROLE",
    });
  });

  it("runs an ADK Runner, exposes AG-UI state to ADK, and emits one lifecycle", async () => {
    let observedState: Record<string, unknown> | undefined;
    const root = new ScriptedAgent((context) => {
      observedState = structuredClone(context.session.state);
      const stateEvent = textEvent({ id: "answer", text: "Hello back" });
      stateEvent.actions.stateDelta = { count: 2 };
      return [stateEvent];
    });
    const runner = new Runner({
      appName: "test-app",
      agent: root,
      sessionService: new InMemorySessionService(),
    });
    const bridge = new ADKAgent({ runner, userId: "user-1" });

    const events = await collect(
      bridge,
      runInput({
        state: { count: 1 },
        context: [{ description: "tenant", value: "acme" }],
      }),
    );

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[1]).toEqual({
      type: EventType.STATE_SNAPSHOT,
      snapshot: { count: 1 },
    });
    expect(observedState).toMatchObject({ count: 1 });
    expect(
      events.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === EventType.RUN_ERROR),
    ).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("preserves usage collected before an ADK run error", async () => {
    const usage = createEvent({
      id: "usage-before-error",
      author: "scripted_agent",
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 1,
        totalTokenCount: 5,
      },
    });
    usage.modelVersion = "local-test-model";
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => [
          usage,
          createEvent({
            id: "model-error",
            author: "scripted_agent",
            errorCode: "MODEL_ERROR",
            errorMessage: "model failed",
          }),
        ]),
      }),
      userId: "user-1",
      usageProvider: "openai-compatible",
    });

    const events = await collect(bridge, runInput());

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "MODEL_ERROR",
      usage: [
        {
          provider: "openai-compatible",
          model: "local-test-model",
          inputTokens: 4,
          outputTokens: 1,
          totalTokens: 5,
        },
      ],
    });
  });

  it("clears stale ADK values when a later AG-UI snapshot removes a key", async () => {
    const observedStates: Record<string, unknown>[] = [];
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService,
        agent: new ScriptedAgent((context) => {
          observedStates.push(structuredClone(context.session.state));
          return [
            textEvent({ id: crypto.randomUUID(), text: "state observed" }),
          ];
        }),
      }),
      userId: "user-1",
    });

    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "First",
    };
    await collect(
      bridge,
      runInput({
        state: { keep: 1, removed: "stale" },
        messages: [firstMessage],
      }),
    );
    const second = await collect(
      bridge,
      runInput({
        runId: "run-2",
        state: { keep: 2 },
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "Second" },
        ],
      }),
    );

    expect(observedStates[1]).toMatchObject({ keep: 2, removed: null });
    expect(
      second.filter((event) => event.type === EventType.STATE_SNAPSHOT).at(-1),
    ).toEqual({ type: EventType.STATE_SNAPSHOT, snapshot: { keep: 2 } });
    const session = await sessionService.getSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
    });
    expect(session?.state.removed).toBeNull();
  });

  it("executes a real ADK Agent backend-tool loop", async () => {
    let receivedArgs: unknown;
    const model = new DeterministicLlm([
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "backend-call-1",
                name: "add_numbers",
                args: { left: 2, right: 3 },
              },
            },
          ],
        },
      },
      {
        content: {
          role: "model",
          parts: [{ text: "The result is 5." }],
        },
      },
    ]);
    const tool = new FunctionTool({
      name: "add_numbers",
      description: "Add two numbers",
      execute: (input) => {
        receivedArgs = input;
        return { result: 5 };
      },
    });
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({ name: "real_agent", model, tools: [tool] }),
      }),
      userId: "user-1",
    });

    const events = await collect(bridge.clone(), runInput());

    expect(receivedArgs).toEqual({ left: 2, right: 3 });
    expect(model.callCount).toBe(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_START,
          toolCallId: "backend-call-1",
          toolCallName: "add_numbers",
        }),
        expect.objectContaining({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: "backend-call-1",
          content: '{"result":5}',
        }),
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "The result is 5.",
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("continues a real ADK Agent after a frontend tool result", async () => {
    const clientTools = new AGUIClientToolset();
    const model = new DeterministicLlm([
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "frontend-call-1",
                name: "client_action",
                args: { value: 7 },
              },
            },
          ],
        },
      },
      {
        content: {
          role: "model",
          parts: [{ text: "The frontend accepted the action." }],
        },
      },
    ]);
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new Agent({
          name: "real_agent",
          model,
          tools: [clientTools],
        }),
      }),
      userId: "user-1",
    });
    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Run the frontend action",
    };
    const first = await collect(
      bridge.clone(),
      runInput({
        messages: [firstMessage],
        tools: [
          {
            name: "client_action",
            description: "Runs in the browser",
            parameters: {
              type: "object",
              properties: { value: { type: "number" } },
              required: ["value"],
            },
          },
        ],
      }),
    );
    const start = first.find(
      (event) =>
        event.type === EventType.TOOL_CALL_START &&
        event.toolCallId === "frontend-call-1",
    );
    expect(start).toMatchObject({
      type: EventType.TOOL_CALL_START,
      toolCallName: "client_action",
    });
    await expect(
      lastValueFrom(from(first).pipe(verifyEvents(false), toArray())),
    ).resolves.toHaveLength(first.length);
    if (!start || start.type !== EventType.TOOL_CALL_START) {
      throw new Error("Expected frontend TOOL_CALL_START.");
    }
    if (typeof start.parentMessageId !== "string") {
      throw new Error("Expected frontend tool call to have a parent message.");
    }

    const second = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          {
            id: start.parentMessageId,
            role: "assistant",
            toolCalls: [
              {
                id: "frontend-call-1",
                type: "function",
                function: {
                  name: "client_action",
                  arguments: '{"value":7}',
                },
              },
            ],
          },
          {
            id: "frontend-result-1",
            role: "tool",
            toolCallId: "frontend-call-1",
            content: '{"accepted":true}',
          },
        ],
        tools: [
          {
            name: "client_action",
            description: "Runs in the browser",
            parameters: { type: "object" },
          },
        ],
      }),
    );

    expect(model.callCount).toBe(2);
    expect(second).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "The frontend accepted the action.",
        }),
      ]),
    );
    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("maps an ADK input request to an interrupt and resumes with a function response", async () => {
    const seenResponses: unknown[] = [];
    const root = new ScriptedAgent((context) => {
      const response = context.userContent?.parts?.[0]?.functionResponse;
      if (response) {
        seenResponses.push(response);
        return [textEvent({ id: "resumed", text: "Thanks" })];
      }
      return [
        createEvent({
          id: "request",
          author: "scripted_agent",
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "interrupt-1",
                  name: "adk_request_input",
                  args: { message: "Which region?" },
                },
              },
            ],
          },
          longRunningToolIds: ["interrupt-1"],
        }),
      ];
    });
    const runner = new Runner({
      appName: "test-app",
      agent: root,
      sessionService: new InMemorySessionService(),
    });
    const bridge = new ADKAgent({ runner, userId: "user-1" });

    const first = await collect(bridge, runInput());
    expect(first.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "interrupt-1",
            reason: "input_required",
            message: "Which region?",
          },
        ],
      },
    });
    const messagesSnapshotIndex = first.findIndex(
      (event) => event.type === EventType.MESSAGES_SNAPSHOT,
    );
    expect(messagesSnapshotIndex).toBeGreaterThan(-1);
    expect(messagesSnapshotIndex).toBeLessThan(first.length - 1);
    expect(first[messagesSnapshotIndex]).toMatchObject({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "user-1", role: "user", content: "Hello" }],
    });
    expect(first.at(-1)).not.toHaveProperty("outcome.interrupts.0.toolCallId");
    await expect(
      lastValueFrom(from(first).pipe(verifyEvents(false), toArray())),
    ).resolves.toHaveLength(first.length);

    const second = await collect(
      bridge,
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: "interrupt-1",
            status: "resolved",
            payload: "eu-west",
          },
        ],
      }),
    );
    expect(seenResponses).toEqual([
      {
        id: "interrupt-1",
        name: "adk_request_input",
        response: { result: "eu-west" },
      },
    ]);
    expect(second.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });

  it("rejects partial resumes without executing the ADK agent", async () => {
    let executions = 0;
    const root = new ScriptedAgent(() => {
      executions += 1;
      return [
        createEvent({
          author: "scripted_agent",
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "interrupt-a",
                  name: "adk_request_input",
                  args: { message: "First answer?" },
                },
              },
              {
                functionCall: {
                  id: "interrupt-b",
                  name: "adk_request_input",
                  args: { message: "Second answer?" },
                },
              },
            ],
          },
          longRunningToolIds: ["interrupt-a", "interrupt-b"],
        }),
      ];
    });
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        agent: root,
        sessionService: new InMemorySessionService(),
      }),
      userId: "user-1",
    });

    await collect(bridge.clone(), runInput());
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: "interrupt-a",
            status: "resolved",
            payload: "one",
          },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "PARTIAL_RESUME",
    });
    expect(executions).toBe(1);
  });

  it("blocks new messages while an interrupt is pending", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: { message: "Answer first" },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });

    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Hello",
    };
    await collect(bridge.clone(), runInput({ messages: [firstMessage] }));
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "Ignore that" },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "PENDING_INTERRUPTS",
    });
    expect(executions).toBe(1);
  });

  it("rejects a resume combined with an unseen message", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: { message: "Answer first" },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });
    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "Hello",
    };

    await collect(bridge.clone(), runInput({ messages: [firstMessage] }));
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "Also do this" },
        ],
        resume: [
          {
            interruptId: "interrupt-1",
            status: "resolved",
            payload: "answer",
          },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "RESUME_WITH_NEW_INPUT",
    });
    expect(executions).toBe(1);
  });

  it("replays a completed resume idempotently across request clones", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent((context) => {
          executions += 1;
          if (context.userContent?.parts?.[0]?.functionResponse) {
            const answer = textEvent({ id: "resume-answer", text: "Done" });
            answer.actions.stateDelta = { count: 2 };
            answer.usageMetadata = {
              promptTokenCount: 4,
              candidatesTokenCount: 2,
              totalTokenCount: 6,
            };
            (answer as AdkEvent & { output?: unknown }).output = {
              status: "completed",
            };
            return [answer];
          }
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: { message: "Choose" },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });
    const resume = [
      {
        interruptId: "interrupt-1",
        status: "resolved" as const,
        payload: { choice: "yes" },
      },
    ];

    await collect(bridge.clone(), runInput({ state: { count: 0 } }));
    const completed = await collect(
      bridge.clone(),
      runInput({ runId: "run-2", state: { count: 0 }, resume }),
    );
    const replayed = await collect(
      bridge.clone(),
      runInput({ runId: "run-3", state: { count: 0 }, resume }),
    );

    expect(completed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(replayed.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      result: { status: "completed" },
      outcome: { type: "success" },
      usage: [
        {
          provider: "google",
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
        },
      ],
    });
    expect(
      replayed
        .filter((event) => event.type === EventType.STATE_SNAPSHOT)
        .at(-1),
    ).toEqual({ type: EventType.STATE_SNAPSHOT, snapshot: { count: 2 } });
    expect(
      replayed.find((event) => event.type === EventType.MESSAGES_SNAPSHOT),
    ).toBeUndefined();

    const replayWithNewInput = await collect(
      bridge.clone(),
      runInput({
        runId: "run-4",
        state: { count: 0 },
        messages: [
          { id: "user-1", role: "user", content: "Hello" },
          { id: "new-user-message", role: "user", content: "New work" },
        ],
        resume,
      }),
    );
    expect(replayWithNewInput.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "RESUME_WITH_NEW_INPUT",
    });
    expect(executions).toBe(2);
  });

  it("validates resolved interrupt payloads against the ADK response schema", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [
            createEvent({
              author: "scripted_agent",
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      id: "interrupt-1",
                      name: "adk_request_input",
                      args: {
                        message: "Choose a region",
                        response_schema: {
                          type: "object",
                          properties: { region: { type: "string" } },
                          required: ["region"],
                          additionalProperties: false,
                        },
                      },
                    },
                  },
                ],
              },
              longRunningToolIds: ["interrupt-1"],
            }),
          ];
        }),
      }),
      userId: "user-1",
    });

    await collect(bridge.clone(), runInput());
    const events = await collect(
      bridge.clone(),
      runInput({
        runId: "run-2",
        resume: [
          {
            interruptId: "interrupt-1",
            status: "resolved",
            payload: "not-an-object",
          },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "INVALID_PAYLOAD",
    });
    expect(executions).toBe(1);
  });

  it("rejects client writes to ADK app, user, and temporary state scopes", async () => {
    let executions = 0;
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(() => {
          executions += 1;
          return [];
        }),
      }),
      userId: "user-1",
    });

    for (const key of ["app:shared", "user:profile", "temp:working"]) {
      const events = await collect(
        bridge.clone(),
        runInput({
          threadId: `thread-${key}`,
          runId: `run-${key}`,
          state: { [key]: "not-allowed" },
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_ERROR,
        code: "RESERVED_STATE_SCOPE",
      });
    }
    expect(executions).toBe(0);
  });

  it("globally serializes runs that share one Runner", async () => {
    let active = 0;
    let maximumActive = 0;
    const root = new ScriptedAgent(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [textEvent({ id: crypto.randomUUID(), text: "done" })];
    });
    const bridge = new ADKAgent({
      runner: new Runner({
        appName: "test-app",
        agent: root,
        sessionService: new InMemorySessionService(),
      }),
      userId: "user-1",
    });

    await Promise.all([
      collect(bridge, runInput({ threadId: "thread-a", runId: "run-a" })),
      collect(bridge, runInput({ threadId: "thread-b", runId: "run-b" })),
    ]);
    expect(maximumActive).toBe(1);
  });

  it("fails fast instead of queueing overlapping runs on the same user and thread", async () => {
    let executions = 0;
    let signalStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      userId: "user-1",
      runnerFactory: () =>
        new Runner({
          appName: "test-app",
          sessionService,
          agent: new ScriptedAgent(async () => {
            executions += 1;
            if (executions === 1) {
              signalStarted();
              await firstMayFinish;
            }
            return [textEvent({ id: crypto.randomUUID(), text: "completed" })];
          }),
        }),
    });

    const first = collect(
      bridge.clone(),
      runInput({ threadId: "same-thread", runId: "run-1" }),
    );
    await started;

    const rejected = await collect(
      bridge.clone(),
      runInput({ threadId: "same-thread", runId: "run-2" }),
    );

    expect(rejected.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STATE_SNAPSHOT,
      EventType.RUN_ERROR,
    ]);
    expect(rejected.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "THREAD_BUSY",
    });
    await expect(
      lastValueFrom(from(rejected).pipe(verifyEvents(false), toArray())),
    ).resolves.toHaveLength(rejected.length);
    expect(executions).toBe(1);

    releaseFirst();
    await expect(first).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: EventType.RUN_FINISHED }),
      ]),
    );

    const afterRelease = await collect(
      bridge.clone(),
      runInput({
        threadId: "same-thread",
        runId: "run-3",
        messages: [
          { id: "user-2", role: "user", content: "Run after release" },
        ],
      }),
    );
    expect(afterRelease.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
    expect(executions).toBe(2);
  });

  it("lets factory-created runners execute different threads concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      userId: "user-1",
      runnerFactory: () =>
        new Runner({
          appName: "test-app",
          sessionService,
          agent: new ScriptedAgent(async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
            return [textEvent({ id: crypto.randomUUID(), text: "done" })];
          }),
        }),
    });

    await Promise.all([
      collect(bridge, runInput({ threadId: "thread-a", runId: "run-a" })),
      collect(bridge, runInput({ threadId: "thread-b", runId: "run-b" })),
    ]);
    expect(maximumActive).toBe(2);
  });

  it("does not duplicate full-history user messages in the ADK session", async () => {
    const sessionService = new InMemorySessionService();
    const bridge = new ADKAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService,
        agent: new ScriptedAgent(() => [
          textEvent({ id: crypto.randomUUID(), text: "done" }),
        ]),
      }),
    });

    const firstMessage = {
      id: "user-1",
      role: "user" as const,
      content: "first",
    };
    await collect(bridge, runInput({ messages: [firstMessage] }));
    await collect(
      bridge,
      runInput({
        runId: "run-2",
        messages: [
          firstMessage,
          { id: "user-2", role: "user", content: "second" },
        ],
      }),
    );

    const session = await sessionService.getSession({
      appName: "test-app",
      userId: "user-1",
      sessionId: "thread-1",
    });
    const userTexts = session?.events
      .filter((event) => event.author === "user")
      .flatMap((event) => event.content?.parts ?? [])
      .map((part) => part.text)
      .filter(Boolean);
    expect(userTexts).toEqual(["first", "second"]);
  });

  it("turns abortRun into one ABORTED terminal event", async () => {
    const bridge = new ADKAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(async (context) => {
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return [];
        }),
      }),
    });

    const result = collect(bridge, runInput());
    await new Promise((resolve) => setTimeout(resolve, 5));
    bridge.abortRun();
    const events = await result;

    expect(
      events.filter((event) => event.type === EventType.RUN_ERROR),
    ).toEqual([
      expect.objectContaining({ type: EventType.RUN_ERROR, code: "ABORTED" }),
    ]);
    expect(
      events.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(0);
  });

  it("propagates stream unsubscription as an ADK abort and releases the runner", async () => {
    let execution = 0;
    let signalStarted!: () => void;
    let abortObserved!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });
    const bridge = new ADKAgent({
      userId: "user-1",
      runner: new Runner({
        appName: "test-app",
        sessionService: new InMemorySessionService(),
        agent: new ScriptedAgent(async (context) => {
          execution += 1;
          if (execution > 1) {
            return [textEvent({ id: "after-disconnect", text: "available" })];
          }
          signalStarted();
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener(
              "abort",
              () => {
                abortObserved();
                resolve();
              },
              { once: true },
            );
          });
          return [];
        }),
      }),
    });

    const subscription = bridge.run(runInput()).subscribe();
    await started;
    subscription.unsubscribe();
    await aborted;

    const next = await collect(
      bridge,
      runInput({ threadId: "thread-2", runId: "run-2" }),
    );
    expect(next.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "success" },
    });
  });
});
