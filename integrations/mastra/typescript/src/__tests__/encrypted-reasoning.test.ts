import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import type { BaseEvent, Message, Tool } from "@ag-ui/client";
import { ReasoningEncryptedValueEventSchema } from "@ag-ui/core/schemas";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import {
  collectEvents,
  FakeLocalAgent,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";
import { MastraAgent } from "../mastra";
import { convertAGUIMessagesToMastra } from "../utils";
import {
  decodeReasoningArtifact,
  encodeReasoningArtifact,
} from "../encrypted-reasoning";

// A provider's reasoning artefacts (an Anthropic thinking signature, a redacted
// block, an OpenAI reasoning item) go to the client as
// REASONING_ENCRYPTED_VALUE on the reasoning message, and come back to Mastra
// with that message on a later turn.

const ANTHROPIC_SIGNATURE = { anthropic: { signature: "sig-1" } };

function encryptedValues(events: BaseEvent[]) {
  return events.filter(
    (e) => e.type === EventType.REASONING_ENCRYPTED_VALUE,
  ) as any[];
}

function reasoningStartId(events: BaseEvent[]) {
  return (events.find((e) => e.type === EventType.REASONING_START) as any)
    ?.messageId;
}

describe.each([
  ["local", makeLocalMastraAgent],
  ["remote", makeRemoteMastraAgent],
] as const)("encrypted reasoning out (%s)", (_kind, makeAgent) => {
  it("sends the reasoning's provider metadata when the message closes", async () => {
    const agent = makeAgent({
      streamChunks: [
        { type: "reasoning-start", payload: { id: "r1" } },
        { type: "reasoning-delta", payload: { id: "r1", text: "thinking" } },
        // Anthropic sends the signature on the last delta.
        {
          type: "reasoning-delta",
          payload: {
            id: "r1",
            text: "",
            providerMetadata: ANTHROPIC_SIGNATURE,
          },
        },
        { type: "reasoning-end", payload: { id: "r1" } },
        { type: "text-delta", payload: { text: "Answer" } },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    const types = events.map((e) => e.type);
    const end = types.indexOf(EventType.REASONING_MESSAGE_END);
    expect(types.slice(end, end + 3)).toEqual([
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_ENCRYPTED_VALUE,
      EventType.REASONING_END,
    ]);
    const [value] = encryptedValues(events);
    expect(value).toMatchObject({
      subtype: "message",
      entityId: reasoningStartId(events),
    });
    expect(() => ReasoningEncryptedValueEventSchema.parse(value)).not.toThrow();
    expect(decodeReasoningArtifact(value.encryptedValue)).toEqual({
      providerMetadata: ANTHROPIC_SIGNATURE,
    });
  });

  it("merges artefacts from the start, delta and end chunks", async () => {
    const agent = makeAgent({
      streamChunks: [
        {
          type: "reasoning-start",
          payload: {
            id: "rs_1",
            providerMetadata: { openai: { itemId: "rs_1" } },
          },
        },
        {
          type: "reasoning-delta",
          payload: {
            id: "rs_1",
            text: "summary",
            providerMetadata: { openai: { itemId: "rs_1" } },
          },
        },
        {
          type: "reasoning-end",
          payload: {
            id: "rs_1",
            signature: "v4-signature",
            providerMetadata: {
              openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
            },
          },
        },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    const values = encryptedValues(events);
    expect(values).toHaveLength(1);
    expect(decodeReasoningArtifact(values[0].encryptedValue)).toEqual({
      providerMetadata: {
        openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
      },
      signature: "v4-signature",
    });
  });

  it("sends nothing for reasoning without artefacts", async () => {
    const agent = makeAgent({
      streamChunks: [
        { type: "reasoning-delta", payload: { text: "plain" } },
        { type: "text-delta", payload: { text: "Answer" } },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    expect(encryptedValues(events)).toEqual([]);
  });

  it("maps a reasoning-signature chunk onto the open reasoning message", async () => {
    const agent = makeAgent({
      streamChunks: [
        { type: "reasoning-delta", payload: { text: "thinking" } },
        {
          type: "reasoning-signature",
          payload: { id: "r1", signature: "sig-v4" },
        },
        { type: "text-delta", payload: { text: "Answer" } },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    const [value] = encryptedValues(events);
    expect(value.entityId).toBe(reasoningStartId(events));
    expect(decodeReasoningArtifact(value.encryptedValue)).toEqual({
      signature: "sig-v4",
    });
  });

  it("amends the last reasoning message for an artefact that arrives after it closed", async () => {
    const agent = makeAgent({
      streamChunks: [
        {
          type: "reasoning-start",
          payload: { id: "r1", providerMetadata: { openai: { itemId: "r1" } } },
        },
        { type: "reasoning-delta", payload: { id: "r1", text: "thinking" } },
        { type: "text-delta", payload: { text: "Answer" } },
        {
          type: "reasoning-signature",
          payload: { id: "r1", signature: "late" },
        },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    const values = encryptedValues(events);
    expect(values.map((v) => v.entityId)).toEqual([
      reasoningStartId(events),
      reasoningStartId(events),
    ]);
    // The event replaces the stored value, so the second carries both parts.
    expect(decodeReasoningArtifact(values[1].encryptedValue)).toEqual({
      providerMetadata: { openai: { itemId: "r1" } },
      signature: "late",
    });
  });

  it("gives a redacted block with no visible reasoning a message of its own", async () => {
    const agent = makeAgent({
      streamChunks: [
        { type: "redacted-reasoning", payload: { id: "r1", data: "opaque" } },
        { type: "text-delta", payload: { text: "Answer" } },
      ],
    });
    const events = await collectEvents(agent, makeInput());

    expect(events.map((e) => e.type).slice(1, 6)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_ENCRYPTED_VALUE,
      EventType.REASONING_END,
    ]);
    expect(
      decodeReasoningArtifact(encryptedValues(events)[0].encryptedValue),
    ).toEqual({ redactedData: "opaque" });
  });

  describe("reasoning still open when the run ends", () => {
    it("sends the artefact when the run stops on a suspended server tool", async () => {
      const agent = makeAgent({
        streamChunks: [
          ...SIGNED_REASONING,
          {
            type: "tool-call",
            payload: { toolCallId: "tc-s", toolName: "lookup", args: {} },
          },
          {
            type: "tool-call-suspended",
            payload: {
              toolCallId: "tc-s",
              toolName: "lookup",
              suspendPayload: {},
              args: {},
              resumeSchema: "{}",
            },
          },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      expectArtifactOnClose(events, { providerMetadata: ANTHROPIC_SIGNATURE });
    });

    it("sends the artefact when Mastra stops the run with an `abort` chunk", async () => {
      const agent = makeAgent({
        streamChunks: [
          ...SIGNED_REASONING,
          { type: "abort", runId: "r1", from: "AGENT", payload: {} },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      expectArtifactOnClose(events, { providerMetadata: ANTHROPIC_SIGNATURE });
      expect((events[events.length - 1] as any).outcome).toEqual({
        type: "cancelled",
      });
    });

    it("sends the artefact of a redacted block nothing follows", async () => {
      const agent = makeAgent({
        streamChunks: [
          { type: "redacted-reasoning", payload: { id: "r1", data: "opaque" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      expectArtifactOnClose(events, { redactedData: "opaque" });
    });
  });
});

/** Reasoning with an Anthropic signature and no `reasoning-end`. */
const SIGNED_REASONING = [
  {
    type: "reasoning-start",
    payload: { id: "r1", providerMetadata: ANTHROPIC_SIGNATURE },
  },
  { type: "reasoning-delta", payload: { id: "r1", text: "thinking" } },
];

/**
 * The run closed its reasoning message with the artefact, exactly once, and
 * then finished.
 */
function expectArtifactOnClose(events: BaseEvent[], artifact: unknown) {
  const types = events.map((e) => e.type);
  const end = types.indexOf(EventType.REASONING_MESSAGE_END);
  expect(end).toBeGreaterThan(-1);
  expect(types.slice(end, end + 3)).toEqual([
    EventType.REASONING_MESSAGE_END,
    EventType.REASONING_ENCRYPTED_VALUE,
    EventType.REASONING_END,
  ]);
  const values = encryptedValues(events);
  expect(values).toHaveLength(1);
  expect(values[0].entityId).toBe(reasoningStartId(events));
  expect(decodeReasoningArtifact(values[0].encryptedValue)).toEqual(artifact);
  expect(types.filter((t) => t === EventType.REASONING_END)).toHaveLength(1);
  expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
}

describe("encrypted reasoning out on abortRun()", () => {
  it("sends the artefact of the reasoning open when the run is aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = new FakeLocalAgent();
    fake.stream = async () => ({
      fullStream: (async function* () {
        for (const chunk of SIGNED_REASONING) yield chunk;
        await gate;
      })(),
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    const events: BaseEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      agent.run(makeInput()).subscribe({
        next: (event) => {
          events.push(event);
          if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
            agent.abortRun();
          }
        },
        error: reject,
        complete: resolve,
      });
    });
    release();

    expectArtifactOnClose(events, { providerMetadata: ANTHROPIC_SIGNATURE });
    expect((events[events.length - 1] as any).outcome).toEqual({
      type: "cancelled",
    });
  });
});

describe("encrypted reasoning back to Mastra (history conversion)", () => {
  const assistant = (id: string, text: string): Message => ({
    id,
    role: "assistant",
    content: text,
  });
  const reasoning = (id: string, content: string, encryptedValue?: string) =>
    ({
      id,
      role: "reasoning",
      content,
      ...(encryptedValue !== undefined ? { encryptedValue } : {}),
    }) as Message;

  it("puts a reasoning span ahead of the assistant message that follows it", () => {
    const value = encodeReasoningArtifact({
      providerMetadata: ANTHROPIC_SIGNATURE,
    });
    const [, turn] = convertAGUIMessagesToMastra([
      { id: "u1", role: "user", content: "Hi" },
      reasoning("r1", "thinking", value),
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "show_chart", arguments: "{}" },
          },
        ],
      },
    ]);

    expect(turn).toEqual({
      id: "a1",
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "thinking",
          providerOptions: ANTHROPIC_SIGNATURE,
        },
        {
          type: "tool-call",
          toolCallId: "tc-1",
          toolName: "show_chart",
          args: {},
        },
      ],
    });
  });

  it("keeps the signature and redacted data Mastra's AI SDK v4 parts carry", () => {
    const [turn] = convertAGUIMessagesToMastra([
      reasoning("r1", "thinking", encodeReasoningArtifact({ signature: "s" })),
      reasoning("r2", "", encodeReasoningArtifact({ redactedData: "opaque" })),
      assistant("a1", "Answer"),
    ]);

    expect(turn.content).toEqual([
      { type: "reasoning", text: "thinking", signature: "s" },
      { type: "redacted-reasoning", data: "opaque" },
      { type: "text", text: "Answer" },
    ]);
  });

  it("does not replay reasoning without an artefact, or one another producer issued", () => {
    const result = convertAGUIMessagesToMastra([
      reasoning("r1", "plain"),
      reasoning("r2", "foreign", JSON.stringify({ signature: "not ours" })),
      assistant("a1", "Answer"),
    ]);

    expect(result).toEqual([
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
    ]);
  });

  it("drops a span that is not directly followed by its assistant message", () => {
    const value = encodeReasoningArtifact({ signature: "s" });
    const result = convertAGUIMessagesToMastra([
      reasoning("r1", "thinking", value),
      { id: "u2", role: "user", content: "Next" },
      assistant("a1", "Answer"),
    ]);

    expect(result.map((m) => m.content)).toEqual([
      "Next",
      [{ type: "text", text: "Answer" }],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Real @mastra/core round trip: turn 1 reasons and calls a frontend tool, the
// client answers it, and turn 2's model prompt carries the reasoning back.
// ---------------------------------------------------------------------------

const SHOW_CHART: Tool = {
  name: "show_chart",
  description: "Render a chart",
  parameters: { type: "object", properties: {} },
};

function reasoningModel(prompts: unknown[]) {
  return new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }: { prompt: unknown }) => {
      prompts.push(prompt);
      const answered =
        Array.isArray(prompt) && prompt.some((m: any) => m.role === "tool");
      const chunks = answered
        ? [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Here is the chart." },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: "stop",
            },
          ]
        : [
            { type: "reasoning-start", id: "r" },
            { type: "reasoning-delta", id: "r", delta: "Charting it." },
            {
              type: "reasoning-delta",
              id: "r",
              delta: "",
              providerMetadata: ANTHROPIC_SIGNATURE,
            },
            { type: "reasoning-end", id: "r" },
            {
              type: "tool-call",
              toolCallId: "tc-chart",
              toolName: "show_chart",
              input: "{}",
            },
            {
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: "tool-calls",
            },
          ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        request: { body: {} },
        response: undefined,
      };
    },
  });
}

/** The reasoning parts of the assistant turns in a model prompt. */
function promptReasoning(prompt: unknown) {
  return (prompt as any[])
    .filter((m) => m.role === "assistant" && Array.isArray(m.content))
    .flatMap((m) => m.content)
    .filter((part: any) => part.type === "reasoning");
}

async function frontendToolRoundTrip(opts: {
  memory: boolean;
  stripEncryptedValue?: boolean;
}) {
  const prompts: unknown[] = [];
  const mastraAgent = new Agent({
    id: "chart-agent",
    name: "chart-agent",
    instructions: "Draw charts.",
    model: reasoningModel(prompts) as any,
    ...(opts.memory ? { memory: new MockMemory() as any } : {}),
  });
  const agent = new MastraAgent({
    agentId: "chart-agent",
    agent: mastraAgent,
    resourceId: "resource-1",
  });
  agent.threadId = "thread-reasoning";
  agent.setMessages([{ id: "u1", role: "user", content: "Chart my sales" }]);

  await agent.runAgent({ runId: "run-1", tools: [SHOW_CHART] });

  const stored = agent.messages.find((m) => m.role === "reasoning") as any;
  const call = agent.messages.find(
    (m) => m.role === "assistant" && m.toolCalls?.length,
  ) as any;
  const history = agent.messages.map((m) =>
    opts.stripEncryptedValue && m.role === "reasoning"
      ? { ...m, encryptedValue: undefined }
      : m,
  );
  agent.setMessages([
    ...history,
    {
      id: "tool-1",
      role: "tool",
      toolCallId: call.toolCalls[0].id,
      content: "rendered",
    } as Message,
  ]);

  await agent.runAgent({ runId: "run-2", tools: [SHOW_CHART] });

  return { stored, prompts };
}

describe("encrypted reasoning: real @mastra/core round trip", () => {
  it("the client stores the artefact on the reasoning message", async () => {
    const { stored } = await frontendToolRoundTrip({ memory: false });

    expect(stored.content).toBe("Charting it.");
    expect(decodeReasoningArtifact(stored.encryptedValue)).toEqual({
      providerMetadata: ANTHROPIC_SIGNATURE,
    });
  });

  it("an agent without memory gets the reasoning back only from the replay", async () => {
    const { prompts } = await frontendToolRoundTrip({ memory: false });

    expect(prompts).toHaveLength(2);
    expect(promptReasoning(prompts[1])).toEqual([
      expect.objectContaining({
        type: "reasoning",
        text: "Charting it.",
        providerOptions: expect.objectContaining(ANTHROPIC_SIGNATURE),
      }),
    ]);
  });

  it("without the artefact the reasoning is not in the prompt (control)", async () => {
    const { prompts } = await frontendToolRoundTrip({
      memory: false,
      stripEncryptedValue: true,
    });

    expect(promptReasoning(prompts[1])).toEqual([]);
  });

  it("an agent with memory sends the reasoning once", async () => {
    const { prompts } = await frontendToolRoundTrip({ memory: true });

    const parts = promptReasoning(prompts[1]);
    expect(parts).toHaveLength(1);
    expect(parts[0].providerOptions).toMatchObject(ANTHROPIC_SIGNATURE);
  });
});
