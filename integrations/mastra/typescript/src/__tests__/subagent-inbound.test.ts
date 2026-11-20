import { describe, it, expect } from "vitest";
import type { Message } from "@ag-ui/client";
import {
  FakeMemory,
  collectEvents,
  makeInput,
  runThroughClient,
} from "./helpers";
import {
  FIRST_TURN,
  attributed,
  capture,
  localAgent,
  remoteAgent,
} from "./subagent-helpers";
import { withoutSubagentMessages } from "../subagents";

// A client keeps what an attributed sub-agent streamed and sends it back on
// the next turn. None of it is the supervisor's own history: a supervisor with
// memory would take the sub-agent's calls as its own, and one without would
// read them in its prompt. The delegation's result already carries what the
// supervisor needs.

const SUPERVISOR_MESSAGE = "2a1c5d51-ccf7-438e-ae56-d9f36f272062";

const REPLY = [
  { type: "start", from: "AGENT", payload: { messageId: "reply-1" } },
  { type: "text-delta", from: "AGENT", payload: { text: "You're welcome." } },
  { type: "finish", from: "AGENT", payload: { messageId: "reply-1" } },
];

/** The client's history after one attributed turn, plus a new question. */
async function secondTurn(extra: Message[] = []): Promise<Message[]> {
  const history = await runThroughClient(
    localAgent(capture("a-single"), attributed).agent,
    FIRST_TURN.messages,
    {},
  );
  expect(history.some((m) => m.subagentRunId === "deleg-1")).toBe(true);
  return [
    ...history,
    ...extra,
    { id: "user-2", role: "user", content: "Thanks." },
  ];
}

/**
 * Anything of the sub-agent's messages, as it would reach Mastra: its ids
 * (namespaced, or as the converter sanitizes them) and its own text. The
 * delegation's result legitimately names the sub-agent's native call ids.
 */
function subagentTraces(sent: unknown): string[] {
  const json = JSON.stringify(sent);
  return ["deleg-1/", "deleg-1-", "Let me look.", "thinking about a"].filter(
    (needle) => json.includes(needle),
  );
}

describe("a turn after an attributed delegation", () => {
  it("sends Mastra the supervisor's own history only", async () => {
    const messages = await secondTurn();
    const { agent, fake } = localAgent(REPLY, attributed);
    await collectEvents(agent, makeInput({ runId: "run-2", messages }));
    expect(subagentTraces(fake.lastStreamMessages)).toEqual([]);
    expect(fake.lastStreamMessages!.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(fake.lastStreamMessages![1]).toMatchObject({
      id: SUPERVISOR_MESSAGE,
      content: [
        { type: "text", text: "Delegating." },
        expect.objectContaining({ type: "tool-call", toolCallId: "deleg-1" }),
      ],
    });
  });

  it("drops a result for a sub-agent's call that arrives without attribution", async () => {
    // CopilotKit answers calls a stopped run left open without attribution.
    const messages = await secondTurn([
      {
        id: "finalized-1",
        role: "tool",
        toolCallId: "deleg-1/sub-call-a-0",
        content: "Tool call was cancelled.",
      },
    ]);
    const { agent, fake } = localAgent(REPLY, attributed);
    await collectEvents(agent, makeInput({ runId: "run-2", messages }));
    expect(subagentTraces(fake.lastStreamMessages)).toEqual([]);
    expect(JSON.stringify(fake.lastStreamMessages)).not.toContain(
      "finalized-1",
    );
  });

  it("keeps Mastra memory to the supervisor's messages", async () => {
    const messages = await secondTurn();
    const memory = new FakeMemory();
    memory.recallMessages = [{ id: "user-1" }, { id: SUPERVISOR_MESSAGE }];
    const { agent, fake } = localAgent(REPLY, attributed, { memory });
    await collectEvents(agent, makeInput({ runId: "run-2", messages }));
    expect(subagentTraces(fake.lastStreamMessages)).toEqual([]);
    expect(fake.lastStreamMessages!.at(-1)).toMatchObject({
      id: "user-2",
      role: "user",
    });
  });

  it("sends a remote agent the supervisor's own history only", async () => {
    const messages = await secondTurn();
    const { agent, fake } = remoteAgent(REPLY, attributed);
    await collectEvents(agent, makeInput({ runId: "run-2", messages }));
    expect(subagentTraces(fake.lastStreamMessages)).toEqual([]);
    expect(fake.lastStreamMessages!.at(-1)).toMatchObject({ id: "user-2" });
  });

  it("filters whatever the visibility, as a client may hold an earlier run's", async () => {
    const messages = await secondTurn();
    const { agent, fake } = localAgent(REPLY);
    await collectEvents(agent, makeInput({ runId: "run-2", messages }));
    expect(subagentTraces(fake.lastStreamMessages)).toEqual([]);
  });
});

describe("withoutSubagentMessages", () => {
  it("returns the same history when nothing is attributed", () => {
    const messages: Message[] = [
      { id: "u", role: "user", content: "hi" },
      { id: "a", role: "assistant", content: "hello" },
    ];
    expect(withoutSubagentMessages(messages)).toBe(messages);
  });

  it("drops attributed messages and every result of their calls", () => {
    const messages: Message[] = [
      { id: "u", role: "user", content: "hi" },
      {
        id: "a",
        role: "assistant",
        toolCalls: [
          {
            id: "d",
            type: "function",
            function: { name: "agent-x", arguments: "{}" },
          },
        ],
      },
      { id: "r", role: "reasoning", content: "…", subagentRunId: "d" },
      {
        id: "d/m",
        role: "assistant",
        content: "working",
        subagentRunId: "d",
        toolCalls: [
          {
            id: "d/c",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        toolCallId: "d/c",
        content: "x",
        subagentRunId: "d",
      },
      { id: "t2", role: "tool", toolCallId: "d/c", content: "cancelled" },
      { id: "t3", role: "tool", toolCallId: "d", content: "{}" },
    ];
    expect(withoutSubagentMessages(messages).map((m) => m.id)).toEqual([
      "u",
      "a",
      "t3",
    ]);
  });
});
