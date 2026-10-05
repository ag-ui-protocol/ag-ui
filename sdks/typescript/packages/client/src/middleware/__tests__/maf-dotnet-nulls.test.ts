import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { from, type Observable } from "rxjs";
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import { AbstractAgent, HttpAgent } from "@/agent";

// PNI-573. Microsoft Agent Framework .NET 1.23 with the published
// AGUI.Abstractions 1.0.0 serializes AG-UI events through host-owned JSON
// options, so every unset optional field goes out as an explicit null. These
// are its real SSE streams, captured from the Dojo server on #2913 (MAF 1.23,
// net10.0, Program.cs workaround removed) against aimock. Each rawEvent is the
// real one cut down to a few top-level keys; its nulls are opaque provider data
// and must survive.

// POST /agentic_chat "Hi, I am duaa" (the BEFORE output of #2955).
const AGENTIC_CHAT = [
  `{"type":"RUN_STARTED","threadId":"t1","runId":"r1","parentRunId":null,"input":null}`,
  `{"type":"TEXT_MESSAGE_START","subagentRunId":null,"messageId":"chatcmpl-sZwVO-ktzIGDEfy3","role":"assistant","name":"AgenticChat","rawEvent":{"authorName":"AgenticChat","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TEXT_MESSAGE_CONTENT","subagentRunId":null,"messageId":"chatcmpl-sZwVO-ktzIGDEfy3","delta":"Hello duaa! How can ","rawEvent":{"authorName":"AgenticChat","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TEXT_MESSAGE_CONTENT","subagentRunId":null,"messageId":"chatcmpl-sZwVO-ktzIGDEfy3","delta":"I assist you today?","rawEvent":{"authorName":"AgenticChat","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TEXT_MESSAGE_END","subagentRunId":null,"messageId":"chatcmpl-sZwVO-ktzIGDEfy3"}`,
  `{"type":"RUN_FINISHED","threadId":"t1","runId":"r1","result":null,"outcome":{"type":"success","pendingToolCallIds":null},"usage":[{"provider":null,"model":"gpt-4o","inputTokens":4,"outputTokens":10,"totalTokens":14,"reasoningTokens":null,"cachedInputTokens":null,"cacheWriteInputTokens":null}]}`,
];

// POST /backend_tool_rendering "Weather in San Francisco": adds TOOL_CALL_RESULT.role.
const BACKEND_TOOL = [
  `{"type":"RUN_STARTED","threadId":"t1","runId":"r1","parentRunId":null,"input":null}`,
  `{"type":"TOOL_CALL_START","subagentRunId":null,"toolCallId":"call_get_weather_1","toolCallName":"get_weather","parentMessageId":"chatcmpl-0-gVLlBKHQ9dkxwa","rawEvent":{"authorName":"BackendToolRenderer","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TOOL_CALL_ARGS","subagentRunId":null,"toolCallId":"call_get_weather_1","delta":"{\\"location\\":\\"San Francisco\\"}","rawEvent":{"authorName":"BackendToolRenderer","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TOOL_CALL_END","subagentRunId":null,"toolCallId":"call_get_weather_1","rawEvent":{"authorName":"BackendToolRenderer","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TOOL_CALL_RESULT","subagentRunId":null,"messageId":"call_get_weather_1","toolCallId":"call_get_weather_1","content":"{\\"temperature\\":20,\\"conditions\\":\\"sunny\\",\\"humidity\\":50,\\"wind_speed\\":10,\\"feelsLike\\":25}","role":null,"rawEvent":{"authorName":"BackendToolRenderer","role":"tool","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TEXT_MESSAGE_START","subagentRunId":null,"messageId":"chatcmpl-NG0L5yQS-D_biey7","role":"assistant","name":"BackendToolRenderer","rawEvent":{"authorName":"BackendToolRenderer","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TEXT_MESSAGE_CONTENT","subagentRunId":null,"messageId":"chatcmpl-NG0L5yQS-D_biey7","delta":"Done! I've completed","rawEvent":{"authorName":"BackendToolRenderer","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TEXT_MESSAGE_CONTENT","subagentRunId":null,"messageId":"chatcmpl-NG0L5yQS-D_biey7","delta":" that for you.","rawEvent":{"authorName":"BackendToolRenderer","role":"assistant","conversationId":null,"additionalProperties":null}}`,
  `{"type":"TEXT_MESSAGE_END","subagentRunId":null,"messageId":"chatcmpl-NG0L5yQS-D_biey7"}`,
  `{"type":"RUN_FINISHED","threadId":"t1","runId":"r1","result":null,"outcome":{"type":"success","pendingToolCallIds":null},"usage":[{"provider":null,"model":"gpt-4o","inputTokens":39,"outputTokens":19,"totalTokens":58,"reasoningTokens":null,"cachedInputTokens":null,"cacheWriteInputTokens":null}]}`,
];

// Any endpoint with the model provider unreachable: RUN_ERROR.usage.
const RUN_ERROR = [
  `{"type":"RUN_ERROR","message":"An error occurred while streaming the agent response.","code":"StreamingError","usage":null}`,
];

const MAF_RAW_EVENT = { conversationId: null, additionalProperties: null };

const sse = (lines: string[]) =>
  new Response(lines.map((line) => `data: ${line}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });

function mafAgent(lines: string[]) {
  return new HttpAgent({
    threadId: "t1",
    url: "https://maf.example.test/agentic_chat",
    fetch: async () => sse(lines),
  });
}

class MemoryAgent extends AbstractAgent {
  constructor(private readonly events: BaseEvent[]) {
    super({ threadId: "t1" });
  }
  override run(): Observable<BaseEvent> {
    return from(this.events);
  }
  protected override connect(): Observable<BaseEvent> {
    return from(this.events);
  }
}

async function runCollecting(agent: AbstractAgent, path: "run" | "connect" = "run") {
  const seen: BaseEvent[] = [];
  const subscriber = {
    onEvent: ({ event }: { event: BaseEvent }) => {
      seen.push(event);
    },
  };
  const result =
    path === "run"
      ? await agent.runAgent({ runId: "r1" }, subscriber)
      : await agent.connectAgent({ runId: "r1" }, subscriber);
  return { seen, result };
}

/** Every forgiven field must be absent (not null, not undefined-valued). */
function expectNoForgivenNulls(events: BaseEvent[]) {
  for (const event of events) {
    const record = event as Record<string, unknown>;
    expect(record).not.toHaveProperty("subagentRunId");
    if (event.type === EventType.RUN_STARTED) {
      expect(record).not.toHaveProperty("parentRunId");
      expect(record).not.toHaveProperty("input");
    }
    if (event.type === EventType.TOOL_CALL_RESULT) expect(record).not.toHaveProperty("role");
    if (event.type === EventType.RUN_ERROR) expect(record).not.toHaveProperty("usage");
    if (event.type === EventType.RUN_FINISHED) {
      expect(record).not.toHaveProperty("result");
      expect(record.outcome).toEqual({ type: "success" });
      for (const usage of record.usage as Record<string, unknown>[]) {
        expect(Object.keys(usage).sort()).toEqual(
          ["inputTokens", "model", "outputTokens", "totalTokens"].sort(),
        );
      }
    }
    expect(EventSchema.safeParse(event).success).toBe(true);
  }
}

const warnings = () => vi.mocked(console.warn).mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  vi.stubEnv("SUPPRESS_TRANSFORMATION_WARNINGS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Microsoft Agent Framework .NET 1.23 streams through HttpAgent", () => {
  it("completes agentic chat with the nulls gone, rawEvent intact and warnings logged", async () => {
    const agent = mafAgent(AGENTIC_CHAT);
    const { seen, result } = await runCollecting(agent);

    expect(seen.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expectNoForgivenNulls(seen);
    expect(seen[0]).toEqual({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" });
    expect(seen[1].rawEvent).toMatchObject(MAF_RAW_EVENT);
    expect((seen[5] as Record<string, unknown>).usage).toEqual([
      { model: "gpt-4o", inputTokens: 4, outputTokens: 10, totalTokens: 14 },
    ]);

    const assistant = result.newMessages.find((message: Message) => message.role === "assistant");
    expect(assistant?.content).toBe("Hello duaa! How can I assist you today?");
    expect(assistant).not.toHaveProperty("subagentRunId");
    expect(agent.messages.some((message) => "subagentRunId" in message)).toBe(false);

    const logged = warnings();
    for (const what of [
      "RUN_STARTED.parentRunId: null",
      "RUN_STARTED.input: null",
      "subagentRunId: null",
      "RUN_FINISHED.result: null",
      "RUN_FINISHED.outcome.pendingToolCallIds: null",
      "RUN_FINISHED.usage[].provider: null",
      "RUN_FINISHED.usage[].reasoningTokens: null",
      "RUN_FINISHED.usage[].cachedInputTokens: null",
      "RUN_FINISHED.usage[].cacheWriteInputTokens: null",
    ]) {
      expect(logged.some((line) => line.includes(`deprecated ${what} to an absent field`))).toBe(
        true,
      );
    }
    // Four events carry subagentRunId: null; the notice is given once per run.
    expect(logged.filter((line) => line.includes("deprecated subagentRunId: null"))).toHaveLength(
      1,
    );
  });

  it("completes backend tool rendering, dropping TOOL_CALL_RESULT.role: null", async () => {
    const { seen, result } = await runCollecting(mafAgent(BACKEND_TOOL));

    expect(seen.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expectNoForgivenNulls(seen);
    const toolResult = seen.find((event) => event.type === EventType.TOOL_CALL_RESULT);
    expect(toolResult).toMatchObject({ toolCallId: "call_get_weather_1" });
    expect(result.newMessages.find((message) => message.role === "tool")).toMatchObject({
      toolCallId: "call_get_weather_1",
      content: expect.stringContaining("sunny"),
    });
    expect(warnings().some((line) => line.includes("TOOL_CALL_RESULT.role: null"))).toBe(true);
  });

  it("surfaces MAF's RUN_ERROR as a run error rather than a validation error", async () => {
    const errors: BaseEvent[] = [];
    await expect(
      mafAgent(RUN_ERROR).runAgent(
        { runId: "r1" },
        {
          onRunErrorEvent: ({ event }) => {
            errors.push(event);
          },
        },
      ),
    ).resolves.toBeDefined();
    expect(errors).toEqual([
      {
        type: EventType.RUN_ERROR,
        message: "An error occurred while streaming the agent response.",
        code: "StreamingError",
      },
    ]);
    expect(warnings().some((line) => line.includes("RUN_ERROR.usage: null"))).toBe(true);
  });

  it("gives in-process producers and connectAgent the same tolerance", async () => {
    const events = AGENTIC_CHAT.map((line) => JSON.parse(line) as BaseEvent);
    for (const path of ["run", "connect"] as const) {
      const { seen } = await runCollecting(new MemoryAgent(structuredClone(events)), path);
      expect(seen.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expectNoForgivenNulls(seen);
    }
  });

  it("does not mutate the producer's event objects", async () => {
    const events = BACKEND_TOOL.map((line) => JSON.parse(line) as BaseEvent);
    const original = structuredClone(events);
    await runCollecting(new MemoryAgent(events));
    expect(events).toEqual(original);
  });
});

describe("the MAF tolerance is exactly the listed fields", () => {
  const start = { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" };
  const finish = { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" };
  const usage = { model: "gpt-4o", inputTokens: 1, outputTokens: 1, totalTokens: 2 };

  it.each([
    {
      field: "name",
      events: [
        start,
        { type: EventType.TEXT_MESSAGE_START, messageId: "m", role: "assistant", name: null },
      ],
    },
    { field: "model", events: [start, { ...finish, usage: [{ ...usage, model: null }] }] },
    {
      field: "inputTokens",
      events: [start, { ...finish, usage: [{ ...usage, inputTokens: null }] }],
    },
    { field: "code", events: [{ type: EventType.RUN_ERROR, message: "x", code: null }] },
    {
      field: "usage",
      events: [start, { ...finish, usage: null }],
    },
    {
      field: "description",
      events: [
        start,
        {
          type: EventType.SUBAGENT_STARTED,
          subagentRunId: "s1",
          name: "child",
          description: null,
        },
      ],
    },
    {
      field: "subagentRunId",
      events: [
        start,
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [{ id: "m", role: "assistant", content: "x", subagentRunId: null }],
        },
      ],
    },
    {
      field: "parentRunId",
      events: [{ ...start, input: { threadId: "t1", runId: "r1", parentRunId: null } }],
    },
    {
      field: "role",
      events: [
        start,
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "x",
          toolCallId: "x",
          content: "x",
          role: "user",
        },
      ],
    },
  ])("still rejects another null or invalid value ($field)", async ({ events }) => {
    const agent = new HttpAgent({
      threadId: "t1",
      url: "https://example.test/agent",
      fetch: async () => sse([...events, finish].map((event) => JSON.stringify(event))),
    });
    await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow();
  });

  it("keeps real-value nulls: state, metadata, tool arguments, CUSTOM.value", async () => {
    const data = {
      subagentRunId: null,
      parentRunId: null,
      input: null,
      role: null,
      pendingToolCallIds: null,
      provider: null,
    };
    const events = [
      { ...start },
      { type: EventType.STATE_SNAPSHOT, snapshot: data },
      { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/role", value: null }] },
      { type: EventType.CUSTOM, name: "x", value: null, metadata: data },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "c",
        toolCallName: "tool",
        rawEvent: data,
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "c", delta: JSON.stringify(data) },
      { type: EventType.TOOL_CALL_END, toolCallId: "c" },
      { ...finish, result: data, metadata: data, usage: [usage] },
    ];
    const { seen } = await runCollecting(new MemoryAgent(structuredClone(events) as BaseEvent[]));
    expect(seen).toEqual(events);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("leaves direct schema validation strict", () => {
    for (const line of [...AGENTIC_CHAT, ...BACKEND_TOOL, ...RUN_ERROR]) {
      const event = JSON.parse(line);
      const hasForgivenNull =
        event.subagentRunId === null ||
        event.parentRunId === null ||
        event.input === null ||
        event.role === null ||
        event.usage === null ||
        event.result === null;
      if (hasForgivenNull) expect(EventSchema.safeParse(event).success).toBe(false);
    }
  });
});
