import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EventType,
  defaultApplyEvents,
  type BaseEvent,
  type Message,
  type ToolCall,
  type ToolMessage,
} from "@ag-ui/client";
import { ToolCallStartEventSchema } from "@ag-ui/core/schemas";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { from, lastValueFrom, toArray } from "rxjs";
import { MastraAgent } from "../mastra";
import { convertAGUIMessagesToMastra } from "../utils";
import {
  FakeLocalAgent,
  FakeMemory,
  collectEvents,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";

const CARRIER_1 = {
  traceparent: "00-2918760d6a3f02964b2171c8e5d91b49-b26f8a5a949fc3ff-01",
};
const CARRIER_2 = {
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  tracestate: "congo=t61rcWkgMzE",
};
const CLIENT_TOOLS = [
  { name: "getPageData", description: "Reads the page", parameters: {} },
];

function makeOtlpPayload(
  traceId = "2918760d6a3f02964b2171c8e5d91b49",
  parentSpanId = "b26f8a5a949fc3ff",
) {
  return {
    toolName: "getPageData",
    executionDurationMs: 12,
    spans: {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: "00000000000000aa",
                  parentSpanId,
                  name: "getPageData result",
                  startTimeUnixNano: "1000000",
                  endTimeUnixNano: "2000000",
                  attributes: [
                    { key: "result", value: { stringValue: '{"ok":true}' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function streamedClientToolChunks(
  observability?: unknown,
  opts?: { onFinalOnly?: boolean; omitStreamingEnd?: boolean },
) {
  const startObs = opts?.onFinalOnly ? undefined : observability;
  const finalObs = observability;
  return [
    {
      type: "start",
      payload: { messageId: "msg-a1" },
    },
    {
      type: "tool-call-input-streaming-start",
      payload: {
        toolCallId: "call_1",
        toolName: "getPageData",
        ...(startObs !== undefined ? { observability: startObs } : {}),
      },
    },
    {
      type: "tool-call-delta",
      payload: {
        toolCallId: "call_1",
        toolName: "getPageData",
        argsTextDelta: "{}",
      },
    },
    ...(opts?.omitStreamingEnd
      ? []
      : [
          {
            type: "tool-call-input-streaming-end",
            payload: { toolCallId: "call_1" },
          },
        ]),
    {
      type: "tool-call",
      payload: {
        toolCallId: "call_1",
        toolName: "getPageData",
        args: {},
        ...(finalObs !== undefined ? { observability: finalObs } : {}),
      },
    },
    {
      type: "finish",
      payload: {},
    },
  ];
}

function bufferedToolChunks(observability?: unknown) {
  return [
    {
      type: "start",
      payload: { messageId: "msg-a1" },
    },
    {
      type: "tool-call",
      payload: {
        toolCallId: "call_1",
        toolName: "getPageData",
        args: {},
        ...(observability !== undefined ? { observability } : {}),
      },
    },
    {
      type: "finish",
      payload: {},
    },
  ];
}

function assistantCallMessage(
  id: string,
  toolCallId: string,
  carrier?: unknown,
): Message {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: toolCallId,
        type: "function",
        function: { name: "getPageData", arguments: "{}" },
        ...(carrier !== undefined
          ? { metadata: { mastra: { observability: carrier } } }
          : {}),
      } as ToolCall,
    ],
  };
}

function toolResultMessage(
  id: string,
  toolCallId: string,
  obsMeta?: Record<string, unknown>,
  overrides: Partial<ToolMessage> = {},
): ToolMessage {
  return {
    id,
    role: "tool",
    toolCallId,
    content: '{"product":"food","price":46.99}',
    ...(obsMeta !== undefined
      ? { metadata: { mastra: { observability: obsMeta } } }
      : {}),
    ...overrides,
  };
}

describe("client tool observability carrier (outbound)", () => {
  describe.each([
    ["local", makeLocalMastraAgent],
    ["remote", makeRemoteMastraAgent],
  ] as const)("%s agent path", (_label, makeAgent) => {
    it("emits carrier on TOOL_CALL_START for the streamed tool-call sequence", async () => {
      const agent = makeAgent({
        streamChunks: streamedClientToolChunks(CARRIER_2),
      });
      const events = await collectEvents(
        agent,
        makeInput({ tools: CLIENT_TOOLS as any }),
      );

      const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
      const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(starts).toHaveLength(1);
      expect(() => ToolCallStartEventSchema.parse(starts[0])).not.toThrow();
      expect(starts[0].metadata).toEqual({
        mastra: { observability: CARRIER_2 },
      });
      // Already emitted on TOOL_CALL_START; TOOL_CALL_END does not duplicate it.
      expect(ends).toHaveLength(1);
      expect(ends[0].metadata).toBeUndefined();
    });

    it("falls back to TOOL_CALL_END metadata when only final tool-call carries observability", async () => {
      const agent = makeAgent({
        streamChunks: streamedClientToolChunks(CARRIER_1, {
          onFinalOnly: true,
          omitStreamingEnd: true,
        }),
      });
      const events = await collectEvents(
        agent,
        makeInput({ tools: CLIENT_TOOLS as any }),
      );

      const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
      const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(starts[0].metadata).toBeUndefined();
      expect(ends[0].metadata).toEqual({
        mastra: { observability: CARRIER_1 },
      });
    });

    it("emits carrier on TOOL_CALL_START for the buffered tool-call sequence", async () => {
      const agent = makeAgent({
        streamChunks: bufferedToolChunks(CARRIER_1),
      });
      // Empty tools list takes the buffered path (pendingToolCall -> flush()).
      const events = await collectEvents(agent, makeInput({ tools: [] }));

      const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
      expect(starts).toHaveLength(1);
      expect(() => ToolCallStartEventSchema.parse(starts[0])).not.toThrow();
      expect(starts[0].metadata).toEqual({
        mastra: { observability: CARRIER_1 },
      });
    });

    it("omits metadata when payload.observability is absent or invalid", async () => {
      const invalidValues = [
        undefined,
        null,
        "00-2918760d6a3f02964b2171c8e5d91b49-b26f8a5a949fc3ff-01",
        {},
        { traceparent: "not-a-traceparent" },
        {
          traceparent:
            "00-00000000000000000000000000000000-b26f8a5a949fc3ff-01",
        },
        {
          traceparent:
            "00-2918760d6a3f02964b2171c8e5d91b49-0000000000000000-01",
        },
        {
          traceparent:
            "ff-2918760d6a3f02964b2171c8e5d91b49-b26f8a5a949fc3ff-01",
        },
      ];

      for (const bad of invalidValues) {
        const agent = makeAgent({
          streamChunks: streamedClientToolChunks(bad),
        });
        const events = await collectEvents(
          agent,
          makeInput({ tools: CLIENT_TOOLS as any }),
        );
        const start = events.find((e) => e.type === EventType.TOOL_CALL_START);
        expect(start?.metadata).toBeUndefined();
      }
    });
  });
});

describe("client tool observability round-trip and history filtering", () => {
  afterEach(() => vi.restoreAllMocks());

  it("survives @ag-ui/client event reduction, Run 2 history filtering, and tool-result conversion", async () => {
    const memory = new FakeMemory();
    const userMsg: Message = { id: "u-1", role: "user", content: "hi" };

    // Run 1: Mastra emits a streamed client tool call with a trace carrier.
    const run1Fake = new FakeLocalAgent({
      memory,
      streamChunks: streamedClientToolChunks(CARRIER_1),
    });
    const run1Agent = new MastraAgent({
      agentId: "chatbot",
      agent: run1Fake as any,
      resourceId: "user-1",
    });
    const run1Input = makeInput({
      messages: [userMsg],
      tools: CLIENT_TOOLS as any,
    });
    const run1Events = await collectEvents(run1Agent, run1Input);

    // Apply Run 1 events through @ag-ui/client's real event reducer.
    const mutations = await lastValueFrom(
      defaultApplyEvents(
        run1Input,
        from(run1Events),
        run1Agent as any,
        [],
      ).pipe(toArray()),
    );
    const afterRun1 = mutations.at(-1)?.messages ?? [];
    const assistantMsg = afterRun1.find((m) => m.role === "assistant")!;
    expect(assistantMsg.id).toBe("msg-a1");
    expect((assistantMsg as any).toolCalls[0].metadata).toEqual({
      mastra: { observability: CARRIER_1 },
    });

    // Simulate Mastra memory having stored u-1 and msg-a1 with pending call.
    memory.recallMessages = [
      {
        id: "u-1",
        role: "user",
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: "text", text: "hi" }] },
      },
      {
        id: "msg-a1",
        role: "assistant",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [
            {
              type: "tool-invocation",
              toolInvocation: {
                state: "call",
                toolCallId: "call_1",
                toolName: "getPageData",
                args: {},
              },
            },
          ],
        },
      },
    ];

    // Run 2: client returns ToolMessage with collected OTLP payload.
    const payload = makeOtlpPayload();
    const toolMsg = toolResultMessage("tool-1", "call_1", { payload });
    const run2Fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "text-delta", payload: { text: "Done" } },
        { type: "finish", payload: {} },
      ],
    });
    const run2Agent = new MastraAgent({
      agentId: "chatbot",
      agent: run2Fake as any,
      resourceId: "user-1",
    });

    await collectEvents(
      run2Agent,
      makeInput({
        messages: [userMsg, assistantMsg, toolMsg],
        tools: CLIENT_TOOLS as any,
      }),
    );

    const sent = run2Fake.lastStreamMessages!;
    expect(sent.map((m: any) => m.id)).toEqual(["msg-a1", "tool-1"]);
    const toolPart = sent[1].content[0];
    expect(toolPart).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      toolName: "getPageData",
      __mastraObservability: {
        parentContext: CARRIER_1,
        payload,
      },
    });
  });

  it("resolves carrier from lookupMessages when the assistant message was filtered out of messages", () => {
    const payload = makeOtlpPayload();
    const assistant = assistantCallMessage("a-1", "call_1", CARRIER_1);
    const toolMsg = toolResultMessage("t-1", "call_1", { payload });

    const converted = convertAGUIMessagesToMastra(
      [toolMsg],
      [assistant, toolMsg],
    );
    expect(converted).toHaveLength(1);
    expect((converted[0].content[0] as any).__mastraObservability).toEqual({
      parentContext: CARRIER_1,
      payload,
    });
  });

  it("preserves __mastraObservability alongside content parts and error flag", () => {
    const payload = makeOtlpPayload();
    const assistant = assistantCallMessage("a-1", "call_1", CARRIER_1);
    const toolMsg = toolResultMessage(
      "t-1",
      "call_1",
      { payload },
      {
        content: [{ type: "text", text: "failed output" }],
        error: "permission denied",
      },
    );

    const converted = convertAGUIMessagesToMastra([assistant, toolMsg]);
    const part = converted[1].content[0] as any;
    expect(part.isError).toBe(true);
    expect(part.providerOptions).toEqual({
      mastra: {
        modelOutput: {
          type: "content",
          value: [{ type: "text", text: "failed output" }],
        },
      },
    });
    expect(part.__mastraObservability).toEqual({
      parentContext: CARRIER_1,
      payload,
    });
  });
});

describe("client tool observability missing, forged, and replayed guards", () => {
  afterEach(() => vi.restoreAllMocks());

  it("omits __mastraObservability when ToolMessage has no payload or an empty/invalid payload", () => {
    const assistant = assistantCallMessage("a-1", "call_1", CARRIER_1);
    const missingCases = [
      toolResultMessage("t-1", "call_1"),
      { ...toolResultMessage("t-2", "call_1"), metadata: {} },
      { ...toolResultMessage("t-3", "call_1"), metadata: { mastra: {} } },
      toolResultMessage("t-4", "call_1", {}),
      toolResultMessage("t-5", "call_1", { payload: null }),
      toolResultMessage("t-6", "call_1", { payload: {} }),
      toolResultMessage("t-7", "call_1", { payload: "bad" }),
      toolResultMessage("t-8", "call_1", { payload: [] }),
    ];

    for (const toolMsg of missingCases) {
      const converted = convertAGUIMessagesToMastra([assistant, toolMsg]);
      expect(
        (converted[1].content[0] as any).__mastraObservability,
      ).toBeUndefined();
    }
  });

  it("rejects forged parentContext when the tool call had no carrier", () => {
    const assistant = assistantCallMessage("a-1", "call_1");
    const toolMsg = toolResultMessage("t-1", "call_1", {
      parentContext: CARRIER_1,
      payload: makeOtlpPayload(),
    });

    const converted = convertAGUIMessagesToMastra([assistant, toolMsg]);
    expect(
      (converted[1].content[0] as any).__mastraObservability,
    ).toBeUndefined();
  });

  it("rejects and warns when ToolMessage parentContext or traceparent conflicts with the tool call carrier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const assistant = assistantCallMessage("a-1", "call_1", CARRIER_1);
    const forgedParent = toolResultMessage("t-1", "call_1", {
      parentContext: CARRIER_2,
      payload: makeOtlpPayload(),
    });
    const forgedTraceparent = toolResultMessage("t-2", "call_1", {
      traceparent: CARRIER_2.traceparent,
      payload: makeOtlpPayload(),
    });

    expect(
      (convertAGUIMessagesToMastra([assistant, forgedParent])[1].content[0] as any)
        .__mastraObservability,
    ).toBeUndefined();
    expect(
      (
        convertAGUIMessagesToMastra([assistant, forgedTraceparent])[1]
          .content[0] as any
      ).__mastraObservability,
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed or zeroed traceparent carriers on ToolCall", () => {
    const assistant = assistantCallMessage("a-1", "call_1", {
      traceparent: "00-00000000000000000000000000000000-b26f8a5a949fc3ff-01",
    });
    const toolMsg = toolResultMessage("t-1", "call_1", {
      payload: makeOtlpPayload(),
    });

    const converted = convertAGUIMessagesToMastra([assistant, toolMsg]);
    expect(
      (converted[1].content[0] as any).__mastraObservability,
    ).toBeUndefined();
  });

  it("does not replay __mastraObservability for prior-turn tool results when later assistant turns exist", () => {
    const p1 = makeOtlpPayload();
    const p2 = makeOtlpPayload(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    );
    const messages: Message[] = [
      { id: "u-1", role: "user", content: "q1" },
      assistantCallMessage("a-1", "call_1", CARRIER_1),
      toolResultMessage("t-1", "call_1", { payload: p1 }),
      { id: "a-2", role: "assistant", content: "answer 1" },
      { id: "u-2", role: "user", content: "q2" },
      assistantCallMessage("a-3", "call_2", CARRIER_2),
      toolResultMessage("t-2", "call_2", { payload: p2 }),
    ];

    const converted = convertAGUIMessagesToMastra(messages);
    const tool1Part = converted.find((m) => m.id === "t-1")!.content[0] as any;
    const tool2Part = converted.find((m) => m.id === "t-2")!.content[0] as any;
    expect(tool1Part.__mastraObservability).toBeUndefined();
    expect(tool2Part.__mastraObservability).toEqual({
      parentContext: CARRIER_2,
      payload: p2,
    });
  });

  it("does not replay __mastraObservability when Mastra memory already recorded the tool result", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "u-1",
        role: "user",
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: "text", text: "q1" }] },
      },
      {
        id: "a-1",
        role: "assistant",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [
            {
              type: "tool-invocation",
              toolInvocation: {
                state: "result",
                toolCallId: "call_1",
                toolName: "getPageData",
                args: {},
                result: { ok: true },
              },
            },
          ],
        },
      },
    ];
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "text-delta", payload: { text: "ok" } },
        { type: "finish", payload: {} },
      ],
    });
    const agent = new MastraAgent({
      agentId: "chatbot",
      agent: fake as any,
      resourceId: "user-1",
    });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u-1", role: "user", content: "q1" },
          assistantCallMessage("a-1", "call_1", CARRIER_1),
          toolResultMessage("t-1", "call_1", { payload: makeOtlpPayload() }),
          { id: "u-2", role: "user", content: "q2" },
        ],
      }),
    );

    const sentTool = fake.lastStreamMessages!.find((m: any) => m.id === "t-1");
    expect(sentTool.content[0].__mastraObservability).toBeUndefined();
  });

  it("still attaches __mastraObservability when an unanswered tool result is sent with a new user message", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [
      {
        id: "u-1",
        role: "user",
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: "text", text: "q1" }] },
      },
      {
        id: "a-1",
        role: "assistant",
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [
            {
              type: "tool-invocation",
              toolInvocation: {
                state: "call",
                toolCallId: "call_1",
                toolName: "getPageData",
                args: {},
              },
            },
          ],
        },
      },
    ];
    const payload = makeOtlpPayload();
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "text-delta", payload: { text: "ok" } },
        { type: "finish", payload: {} },
      ],
    });
    const agent = new MastraAgent({
      agentId: "chatbot",
      agent: fake as any,
      resourceId: "user-1",
    });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u-1", role: "user", content: "q1" },
          assistantCallMessage("a-1", "call_1", CARRIER_1),
          toolResultMessage("t-1", "call_1", { payload }),
          { id: "u-2", role: "user", content: "also hello" },
        ],
      }),
    );

    const sentTool = fake.lastStreamMessages!.find((m: any) => m.id === "t-1");
    expect(sentTool.content[0].__mastraObservability).toEqual({
      parentContext: CARRIER_1,
      payload,
    });
  });

  it("matches reused toolCallIds to their own turn's carrier and deduplicates duplicate tool messages", () => {
    const p1 = makeOtlpPayload();
    const p2 = makeOtlpPayload(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    );
    const messages: Message[] = [
      assistantCallMessage("a-1", "call_0", CARRIER_1),
      toolResultMessage("t-1", "call_0", { payload: p1 }),
      { id: "a-2", role: "assistant", content: "done 1" },
      assistantCallMessage("a-3", "call_0", CARRIER_2),
      toolResultMessage("t-2", "call_0", { payload: p2 }),
      toolResultMessage("t-2-dup", "call_0", { payload: p2 }),
    ];

    const converted = convertAGUIMessagesToMastra(messages);
    const t2 = converted.find((m) => m.id === "t-2")!.content[0] as any;
    const t2Dup = converted.find((m) => m.id === "t-2-dup")!.content[0] as any;
    expect(t2.__mastraObservability).toEqual({
      parentContext: CARRIER_2,
      payload: p2,
    });
    expect(t2Dup.__mastraObservability).toBeUndefined();
  });
});

describe("end-to-end with @mastra/core Agent#extractClientObservability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delivers payload and carrier to Mastra's ClientObservabilityProxy.receive() and strips __mastraObservability before the model", async () => {
    const receivedCalls: Array<{ payload: unknown; parentContext: unknown }> =
      [];
    const seenPrompts: unknown[] = [];
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const makeStream = (parts: any[]) => ({
      stream: new ReadableStream({
        start(c) {
          for (const part of parts) c.enqueue(part);
          c.close();
        },
      }),
    });

    const model = new MastraLanguageModelV2Mock({
      doStream: async (opts: any) => {
        seenPrompts.push(opts.prompt);
        return makeStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "Hello!" },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: "stop",
            usage,
          },
        ]);
      },
    });

    const memory = new MockMemory();
    const chatbot = new Agent({
      id: "chatbot",
      name: "chatbot",
      instructions: "x",
      model: model as any,
      memory: memory as any,
    });

    const mockMastra = new Mastra({
      logger: false,
      agents: { chatbot },
    });
    // Wire a mock ClientObservabilityProxy onto the Mastra observability instance
    // so we can exercise Agent#extractClientObservability without @mastra/observability.
    Object.defineProperty(
      mockMastra.observability,
      "getClientObservabilityProxy",
      {
        configurable: true,
        value: () => ({
          inject: () => CARRIER_1,
          receive: (payload: unknown, parentContext: unknown) => {
            receivedCalls.push({ payload, parentContext });
          },
        }),
      },
    );

    const userMsg: Message = { id: "u-1", role: "user", content: "hi" };
    const assistantMsg = assistantCallMessage("a-1", "call_1", CARRIER_1);
    const payload = makeOtlpPayload();
    const toolMsg = toolResultMessage("t-1", "call_1", { payload });

    const aguiAgent = new MastraAgent({
      agent: mockMastra.getAgent("chatbot"),
      resourceId: "user-1",
    });

    const events = await collectEvents(
      aguiAgent,
      makeInput({
        threadId: "thread-e2e-1",
        messages: [userMsg, assistantMsg, toolMsg],
        tools: CLIENT_TOOLS as any,
      }),
    );

    expect(
      events.some(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CHUNK &&
          (e as any).delta === "Hello!",
      ),
    ).toBe(true);
    expect(receivedCalls).toEqual([
      {
        payload,
        parentContext: CARRIER_1,
      },
    ]);
    // Mastra's extractClientObservability stripped __mastraObservability before
    // building the model prompt.
    const promptJson = JSON.stringify(seenPrompts[0]);
    expect(promptJson).not.toContain("__mastraObservability");
    expect(promptJson).not.toContain(CARRIER_1.traceparent);
  });
});
