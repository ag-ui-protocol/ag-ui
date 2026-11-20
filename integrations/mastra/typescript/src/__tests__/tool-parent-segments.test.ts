import { describe, expect, it, vi } from "vitest";
import { EventType, type Message } from "@ag-ui/client";
import {
  collectEvents,
  FakeLocalAgent,
  FakeMemory,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  runThroughClient,
} from "./helpers";

const BASE = "turn";
const SEGMENT = `${BASE}-agui-text`;
const start = (messageId = BASE) => ({
  type: "step-start",
  payload: { messageId },
});
const text = (value: string) => ({
  type: "text-delta",
  payload: { text: value },
});
const call = (toolCallId: string) => ({
  type: "tool-call",
  payload: { toolCallId, toolName: "lookup", args: {} },
});
const result = (toolCallId: string) => ({
  type: "tool-result",
  payload: { toolCallId, toolName: "lookup", args: {}, result: "ok" },
});
const finish = (value?: string, type = "step-finish") => ({
  type,
  payload:
    value === undefined
      ? {}
      : {
          response: {
            uiMessages: [
              { role: "assistant", content: [{ type: "text", text: value }] },
            ],
          },
        },
});
const tool = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "lookup", arguments: "{}" },
});
const owners = (messages: Message[]) =>
  messages
    .filter((m) => m.role === "assistant")
    .map((m) => [m.id, m.content ?? "", m.toolCalls?.map((t) => t.id) ?? []]);

// #3130: tool ownership must preserve the model's text/tool order, including
// when the text content is withheld until an output processor finishes.
describe.each([false, true])(
  "tool parents (processed text: %s)",
  (useProcessedFinalText) => {
    it("parents tools on each preceding text segment in a text-first turn", async () => {
      const agent = makeLocalMastraAgent({
        useProcessedFinalText,
        streamChunks: [
          start(),
          text("first"),
          call("c1"),
          result("c1"),
          finish("first"),
          start(),
          text("second"),
          call("c2"),
          result("c2"),
          finish("second"),
          start(),
          text("last"),
          finish("last", "finish"),
        ],
      });
      expect(
        owners(await runThroughClient(agent, [], { runId: "run" })),
      ).toEqual([
        [BASE, "first", ["c1"]],
        [SEGMENT, "second", ["c2"]],
        [`${SEGMENT}-2`, "last", []],
      ]);
    });

    it.each([makeLocalMastraAgent, makeRemoteMastraAgent])(
      "keeps tool-first alternation in client order (%#)",
      async (makeAgent) => {
        const streamChunks = [
          start(),
          call("c1"),
          result("c1"),
          finish(),
          start(),
          text("raw middle"),
          call("c2"),
          result("c2"),
          finish("middle"),
          start(),
          text("raw last"),
          finish("last", "finish"),
        ];
        const agent = makeAgent({ useProcessedFinalText, streamChunks });
        const events = await collectEvents(agent, makeInput());
        expect(
          events
            .filter((e) => e.type === EventType.TOOL_CALL_START)
            .map((e) => [e.toolCallId, e.parentMessageId]),
        ).toEqual([
          ["c1", BASE],
          ["c2", SEGMENT],
        ]);
        const messages = await runThroughClient(
          makeAgent({ useProcessedFinalText, streamChunks }),
          [],
          { runId: "run" },
        );
        expect(owners(messages)).toEqual([
          [BASE, "", ["c1"]],
          [SEGMENT, useProcessedFinalText ? "middle" : "raw middle", ["c2"]],
          [`${SEGMENT}-2`, useProcessedFinalText ? "last" : "raw last", []],
        ]);
        expect(messages.map((m) => m.role)).toEqual([
          "assistant",
          "tool",
          "assistant",
          "tool",
          "assistant",
        ]);
      },
    );

    it("keeps consecutive tools together even after buffered text is released", async () => {
      const agent = makeLocalMastraAgent({
        useProcessedFinalText,
        streamChunks: [
          start(),
          text("first"),
          call("c1"),
          finish("first"),
          start(),
          call("c2"),
          result("c2"),
          text("last"),
          finish("last", "finish"),
        ],
      });
      const messages = await runThroughClient(agent, [], { runId: "run" });
      expect(owners(messages)).toEqual([
        [BASE, "first", ["c1", "c2"]],
        [SEGMENT, "last", []],
      ]);
    });

    it("does not carry a text parent into a fresh native message", async () => {
      const agent = makeLocalMastraAgent({
        useProcessedFinalText,
        streamChunks: [
          start(),
          call("c1"),
          finish(),
          start(),
          text("middle"),
          finish("middle"),
          start("new-turn"),
          call("c2"),
          result("c2"),
          text("last"),
          finish("last", "finish"),
        ],
      });
      const messages = await runThroughClient(agent, [], { runId: "run" });
      expect(owners(messages)).toEqual([
        [BASE, "", ["c1"]],
        [SEGMENT, "middle", []],
        ["new-turn", "", ["c2"]],
        ["new-turn-agui-text", "last", []],
      ]);
    });
  },
);

it.each([false, true])(
  "round-trips a live suspended continuation-owned call (processed: %s)",
  async (useProcessedFinalText) => {
    const agent = makeLocalMastraAgent({
      useProcessedFinalText,
      streamServerToolCalls: true,
      streamChunks: [
        start(),
        call("c1"),
        result("c1"),
        finish(),
        start(),
        text("Need approval."),
        {
          type: "tool-call-input-streaming-start",
          payload: { toolCallId: "c2", toolName: "lookup" },
        },
        call("c2"),
        {
          type: "tool-call-suspended",
          payload: {
            toolCallId: "c2",
            toolName: "lookup",
            args: {},
            suspendPayload: {},
            runId: "mastra-run",
          },
        },
      ],
      resumeChunks: [
        start(),
        result("c2"),
        text("Done."),
        finish("Done.", "finish"),
      ],
    });
    const suspended = await runThroughClient(agent, [], { runId: "run-1" });
    expect(owners(suspended)).toEqual([
      [BASE, "", ["c1"]],
      [SEGMENT, "Need approval.", ["c2"]],
    ]);
    const resumed = await runThroughClient(agent, suspended, {
      runId: "run-2",
      resume: [
        { interruptId: "mastra-run::c2", status: "resolved", payload: {} },
      ],
    });
    expect(owners(resumed)).toEqual([
      [BASE, "", ["c1"]],
      [SEGMENT, "Need approval.", ["c2"]],
      [`${SEGMENT}-2`, "Done.", []],
    ]);
    expect(resumed[3]).toMatchObject({ role: "tool", toolCallId: "c2" });
  },
);

it("does not leak text removed by an output processor into a tool's parent", async () => {
  const agent = makeLocalMastraAgent({
    useProcessedFinalText: true,
    streamChunks: [
      start(),
      call("c1"),
      finish(),
      start(),
      text("private raw text"),
      call("c2"),
      finish("", "finish"),
    ],
  });
  const messages = await runThroughClient(agent, [], { runId: "run" });
  expect(owners(messages)).toEqual([
    [BASE, "", ["c1"]],
    [SEGMENT, "", ["c2"]],
  ]);
});

const history: Message[] = [
  { id: BASE, role: "assistant", content: "", toolCalls: [tool("c1")] },
  { id: "r1", role: "tool", toolCallId: "c1", content: '"ok"' },
  {
    id: SEGMENT,
    role: "assistant",
    content: "Need approval.",
    toolCalls: [tool("c2")],
  },
];

it("forwards the continuation owner with a fresh result, then dedups both next turn", async () => {
  const memory = new FakeMemory();
  memory.recallMessages = [{ id: BASE }, { id: "r1" }];
  const stream = vi.spyOn(FakeLocalAgent.prototype, "stream");
  try {
    const agent = makeLocalMastraAgent({
      memory,
      streamChunks: [finish(undefined, "finish")],
    });
    const messages: Message[] = [
      ...history,
      { id: "r2", role: "tool", toolCallId: "c2", content: '"approved"' },
    ];
    await collectEvents(agent, makeInput({ messages }));
    expect(stream.mock.lastCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "tool-call", toolCallId: "c2" }),
          ]),
        }),
        expect.objectContaining({
          role: "tool",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "tool-result", toolCallId: "c2" }),
          ]),
        }),
      ]),
    );
    expect(JSON.stringify(stream.mock.lastCall?.[0])).not.toContain('"c1"');
    memory.recallMessages.push({ id: "r2" });
    await collectEvents(
      agent,
      makeInput({
        messages: [
          ...messages,
          { id: "u2", role: "user", content: "Continue" },
        ],
      }),
    );
    expect(stream.mock.lastCall?.[0]).toEqual([
      { id: "u2", role: "user", content: "Continue" },
    ]);
  } finally {
    stream.mockRestore();
  }
});

describe.each([false, true])(
  "resume continuation-owned call (native ID: %s)",
  (announceId) => {
    it.each([makeLocalMastraAgent, makeRemoteMastraAgent])(
      "preserves owner/result pairing and advances the native continuation (%#)",
      async (makeAgent) => {
        const agent = makeAgent({
          resumeChunks: [
            ...(announceId ? [start()] : []),
            result("c2"),
            text("Resumed."),
            call("c3"),
            result("c3"),
            text("Done."),
            finish(undefined, "finish"),
          ],
        });
        const messages = await runThroughClient(agent, history, {
          runId: "run-2",
          resume: [
            { interruptId: "mastra-run::c2", status: "resolved", payload: {} },
          ],
        });
        expect(owners(messages)).toEqual([
          [BASE, "", ["c1"]],
          [SEGMENT, "Need approval.", ["c2"]],
          [`${SEGMENT}-2`, "Resumed.", ["c3"]],
          [`${SEGMENT}-3`, "Done.", []],
        ]);
        expect(messages.map((m) => m.role)).toEqual([
          "assistant",
          "tool",
          "assistant",
          "tool",
          "assistant",
          "tool",
          "assistant",
        ]);
        expect(messages[3]).toMatchObject({ toolCallId: "c2" });
      },
    );
  },
);
