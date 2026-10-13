import { vi } from "vitest";
import {
  FakeMemory,
  FakeLocalAgent,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";
import { encodeReasoningArtifact } from "../encrypted-reasoning";

const SIMPLE_STREAM_CHUNKS = [
  { type: "text-delta", payload: { text: "ok" } },
  { type: "finish", payload: {} },
];

/**
 * OSS-105: AG-UI clients re-send the whole conversation every turn. The bridge
 * must forward only the messages Mastra hasn't already stored (the new turn),
 * so Mastra memory — not the re-sent history — owns the thread. Without this,
 * re-sent history is re-persisted and storage balloons.
 */
describe("only-new-messages diff feed", () => {
  it("forwards only messages whose id is not already stored", async () => {
    const memory = new FakeMemory();
    // Mastra already has the first turn persisted (ids u1 + a1).
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "hi" }] } },
      { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "hello" }] } },
    ];

    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    // Client re-sends the full history + the new user message.
    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "hi" },
          { id: "a1", role: "assistant", content: "hello" },
          { id: "u2", role: "user", content: "say bye" },
        ] as any,
      }),
    );

    const sent = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!;
    const ids = sent.map((m: any) => m.id);
    expect(ids).toEqual(["u2"]); // only the new turn reaches Mastra
  });

  it("forwards the full list on the first turn (nothing stored yet)", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({ messages: [{ id: "u1", role: "user", content: "hi" }] as any }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["u1"]);
  });

  it("sends the full list without warning when the thread does not exist yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = new FakeMemory();
    memory.recall = async () => {
      throw new Error("No thread found with id thread-1");
    };
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({ messages: [{ id: "u1", role: "user", content: "hi" }] as any }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["u1"]);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("Failed to compute new-message diff")),
    ).toBe(false);
    warn.mockRestore();
  });

  it("still warns when recall fails for an existing thread", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const memory = new FakeMemory();
    memory.threads.set("thread-1", { id: "thread-1", resourceId: "resource-1" });
    memory.recall = async () => {
      throw new Error("storage unavailable");
    };
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({ messages: [{ id: "u1", role: "user", content: "hi" }] as any }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["u1"]);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("Failed to compute new-message diff")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("falls back to the full list if every message is already stored", async () => {
    // Defensive: never send an empty turn.
    const memory = new FakeMemory();
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "hi" }] } },
    ];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({ messages: [{ id: "u1", role: "user", content: "hi" }] as any }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["u1"]);
  });

  it("re-includes the matching assistant tool-call when a tool-result is the new turn", async () => {
    // A lone tool-result can't resolve the stored pending call (Mastra appends a
    // separate result → call/result split → model re-calls). So the retained
    // tool-result must travel with its assistant tool-call, in order.
    const memory = new FakeMemory();
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "change bg" }] } },
      { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "call", toolCallId: "tc1", toolName: "change_background", args: {} } }] } },
    ];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "change bg" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc1", type: "function", function: { name: "change_background", arguments: "{}" } }],
          },
          { id: "t1", role: "tool", toolCallId: "tc1", content: "ok" },
        ] as any,
      }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    // a1 (stored) is re-included so it precedes its result; order preserved.
    expect(ids).toEqual(["a1", "t1"]);
  });

  it("keeps the turns between an earlier tool result and a new frontend tool result", async () => {
    // Mastra never stores a tool message under its own id (the result lives in
    // the assistant message that made the call), so an earlier turn's result
    // always looks new. Forwarding it without the turns after it put a1 and a2
    // next to each other; Mastra merges adjacent assistant messages, filed the
    // new ask_user result under a1, and the model asked again (issue #3034).
    const memory = new FakeMemory();
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "q1" }] } },
      { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "result", toolCallId: "tc1", toolName: "lookup", args: {}, result: { rows: 1 } } }] } },
      { id: "u2", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "q2" }] } },
      { id: "a2", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "call", toolCallId: "tc2", toolName: "ask_user", args: {} } }] } },
    ];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "q1" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc1", type: "function", function: { name: "lookup", arguments: "{}" } }],
          },
          { id: "t1", role: "tool", toolCallId: "tc1", content: '{"rows":1}' },
          { id: "u2", role: "user", content: "q2" },
          {
            id: "a2",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc2", type: "function", function: { name: "ask_user", arguments: "{}" } }],
          },
          { id: "t2", role: "tool", toolCallId: "tc2", content: '{"answer":"yes"}' },
        ] as any,
      }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    // The contiguous tail from the first message Mastra has not stored (t1),
    // with u2 kept between the two calls.
    expect(ids).toEqual(["a1", "t1", "u2", "a2", "t2"]);
  });

  it("keeps the turns after the text streamed behind an earlier frontend tool result", async () => {
    // Mastra stores the text the model writes after a frontend tool result
    // inside the message holding the call, so its streamed id (a2) is never
    // stored either and starts the tail (issue #3034).
    const memory = new FakeMemory();
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "q1" }] } },
      { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "result", toolCallId: "tc1", toolName: "ask_user", args: {}, result: { answer: "first" } } }, { type: "text", text: "thanks" }] } },
      { id: "u2", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "q2" }] } },
      { id: "a3", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "call", toolCallId: "tc2", toolName: "ask_user", args: {} } }] } },
    ];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "q1" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc1", type: "function", function: { name: "ask_user", arguments: "{}" } }],
          },
          { id: "t1", role: "tool", toolCallId: "tc1", content: '{"answer":"first"}' },
          { id: "a2", role: "assistant", content: "thanks" },
          { id: "u2", role: "user", content: "q2" },
          {
            id: "a3",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc2", type: "function", function: { name: "ask_user", arguments: "{}" } }],
          },
          { id: "t2", role: "tool", toolCallId: "tc2", content: '{"answer":"second"}' },
        ] as any,
      }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["a1", "t1", "a2", "u2", "a3", "t2"]);
  });

  it("still forwards a frontend tool result sent together with the next user message", async () => {
    const memory = new FakeMemory();
    memory.recallMessages = [
      { id: "u1", role: "user", createdAt: new Date(), content: { format: 2, parts: [{ type: "text", text: "change bg" }] } },
      { id: "a1", role: "assistant", createdAt: new Date(), content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "call", toolCallId: "tc1", toolName: "change_background", args: {} } }] } },
    ];
    const agent = makeLocalMastraAgent({ memory, streamChunks: SIMPLE_STREAM_CHUNKS });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "change bg" },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc1", type: "function", function: { name: "change_background", arguments: "{}" } }],
          },
          { id: "t1", role: "tool", toolCallId: "tc1", content: "ok" },
          { id: "u2", role: "user", content: "now make it blue" },
        ] as any,
      }),
    );

    const ids = (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!.map((m: any) => m.id);
    expect(ids).toEqual(["a1", "t1", "u2"]);
  });

  describe("reasoning travels with the message that follows it", () => {
    // Reasoning messages carry bridge-minted ids Mastra never stores, so they
    // are judged by the message they belong to.
    const signed = encodeReasoningArtifact({ signature: "sig" });
    const stored = (id: string, role: string) => ({
      id,
      role,
      createdAt: new Date(),
      content: { format: 2, parts: [{ type: "text", text: "x" }] },
    });

    async function sentFor(storedIds: string[][], messages: unknown[]) {
      const memory = new FakeMemory();
      memory.recallMessages = storedIds.map(([id, role]) => stored(id, role));
      const agent = makeLocalMastraAgent({
        memory,
        streamChunks: SIMPLE_STREAM_CHUNKS,
      });
      await collectEvents(agent, makeInput({ messages: messages as any }));
      return (agent.agent as unknown as FakeLocalAgent).lastStreamMessages!;
    }

    it("drops the reasoning of a stored turn", async () => {
      const sent = await sentFor(
        [
          ["u1", "user"],
          ["a1", "assistant"],
        ],
        [
          { id: "u1", role: "user", content: "hi" },
          { id: "r1", role: "reasoning", content: "hm", encryptedValue: signed },
          { id: "a1", role: "assistant", content: "hello" },
          { id: "u2", role: "user", content: "bye" },
        ],
      );

      expect(sent.map((m: any) => m.id)).toEqual(["u2"]);
    });

    it("replays the reasoning of a stored call re-sent with its new result", async () => {
      const sent = await sentFor(
        [
          ["u1", "user"],
          ["a1", "assistant"],
        ],
        [
          { id: "u1", role: "user", content: "chart it" },
          { id: "r1", role: "reasoning", content: "hm", encryptedValue: signed },
          {
            id: "a1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "show_chart", arguments: "{}" },
              },
            ],
          },
          { id: "t1", role: "tool", toolCallId: "tc1", content: "ok" },
        ],
      );

      expect(sent.map((m: any) => m.id)).toEqual(["a1", "t1"]);
      expect(sent[0].content[0]).toEqual({
        type: "reasoning",
        text: "hm",
        signature: "sig",
      });
    });
  });

  it("forwards the full list for remote agents (no local memory to dedupe against)", async () => {
    const agent = makeRemoteMastraAgent({ streamChunks: SIMPLE_STREAM_CHUNKS });
    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: "u1", role: "user", content: "hi" },
          { id: "u2", role: "user", content: "bye" },
        ] as any,
      }),
    );
    const ids = (agent.agent as any).lastStreamMessages?.map((m: any) => m.id) ?? null;
    // Remote fake records messages too; both forwarded unchanged.
    expect(ids).toEqual(["u1", "u2"]);
  });
});
