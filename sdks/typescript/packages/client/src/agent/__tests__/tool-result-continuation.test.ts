import { describe, expect, it } from "vitest";
import { of } from "rxjs";
import { AbstractAgent } from "../agent";
import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type ToolMessage,
} from "@ag-ui/core";

const history: Message[] = [
  {
    id: "call-message",
    role: "assistant",
    toolCalls: [
      {
        id: "frontend-call",
        type: "function",
        function: { name: "chart", arguments: '{"value":17}' },
      },
      { id: "native-call", type: "function", function: { name: "native", arguments: "{}" } },
    ],
  },
];
const result: ToolMessage = {
  id: "result",
  role: "tool",
  toolCallId: "frontend-call",
  content: '  {"exact":17}  ',
};
const tools = [{ name: "chart", description: "chart", parameters: { type: "object" as const } }];
class Agent extends AbstractAgent {
  inputs: RunAgentInput[] = [];
  expired = false;
  run(input: RunAgentInput) {
    this.inputs.push(input);
    return of(...this.events(input, this.messages));
  }
  protected connect(input: RunAgentInput) {
    return of(...this.events(input, history));
  }
  private events(input: RunAgentInput, messages: Message[]): BaseEvent[] {
    return [
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.MESSAGES_SNAPSHOT, messages },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: {
          type: "interrupt",
          interrupts: [
            {
              id: "native-request",
              reason: "tool_call",
              toolCallId: "native-call",
              ...(this.expired ? { expiresAt: "2000-01-01T00:00:00Z" } : {}),
            },
          ],
        },
      },
    ];
  }
}
async function ready(enabled = true) {
  const agent = new Agent({ allowToolResultContinuation: enabled });
  await agent.connectAgent();
  agent.addMessage(structuredClone(result));
  return agent;
}
describe("explicit result-only continuation", () => {
  it("persists exact result delta while preserving original pending native interrupt", async () => {
    const agent = await ready();
    await agent.runAgent({ tools, toolResultContinuation: [result] });
    expect(agent.inputs[0]?.messages).toEqual([result]);
    expect(agent.inputs[0]?.resume).toBeUndefined();
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["native-request"]);
    expect(agent.messages.filter((m) => m.role === "tool")).toEqual([result]);
    await expect(agent.runAgent({ tools, toolResultContinuation: [result] })).rejects.toThrow(
      /Invalid tool-result/,
    );
    expect(agent.inputs).toHaveLength(1);
  });
  it("retains capability and checkpoint through clone", async () => {
    const agent = (await ready()).clone();
    // Subclass-specific inputs are deliberately initialized separately.
    agent.inputs = [];
    await agent.runAgent({ tools, toolResultContinuation: [result] });
    expect(agent.inputs[0]?.messages).toEqual([result]);
  });
  it("does not weaken the ordinary missing-resume guard", async () => {
    await expect((await ready()).runAgent({ tools })).rejects.toThrow(/pending interrupt/);
  });
  it("keeps the default capability disabled", async () => {
    await expect(
      (await ready(false)).runAgent({ tools, toolResultContinuation: [result] }),
    ).rejects.toThrow(/Invalid tool-result/);
  });
  it("honors capability revocation after recording the checkpoint", async () => {
    const agent = await ready();
    agent.allowToolResultContinuation = false;
    await expect(agent.runAgent({ tools, toolResultContinuation: [result] })).rejects.toThrow(
      /Invalid tool-result/,
    );
    expect(agent.inputs).toHaveLength(0);
  });
  it("does not establish authority from seeded messages and pending IDs", async () => {
    const agent = new Agent({
      allowToolResultContinuation: true,
      initialMessages: [...history, result],
    });
    agent.pendingInterrupts = [
      { id: "native-request", reason: "tool_call", toolCallId: "native-call" },
    ];
    await expect(agent.runAgent({ tools, toolResultContinuation: [result] })).rejects.toThrow(
      /Invalid tool-result/,
    );
    expect(agent.inputs).toHaveLength(0);
  });
  for (const kind of [
    "unknown",
    "native",
    "duplicate",
    "user",
    "assistant",
    "history",
    "state",
    "resume",
    "expired",
    "thread",
    "tool-name",
  ] as const) {
    it(`rejects ${kind} without sending`, async () => {
      const agent = await ready();
      let selected: ToolMessage[] = [result];
      let selectedTools = tools;
      if (kind === "unknown" || kind === "native") {
        selected = [{ ...result, toolCallId: kind === "native" ? "native-call" : "unknown" }];
        agent.messages[1] = selected[0]!;
      }
      if (kind === "duplicate") selected = [result, result];
      if (kind === "user" || kind === "assistant")
        agent.addMessage({ id: "extra", role: kind, content: "changed" });
      if (kind === "history")
        agent.messages[0] = { id: "call-message", role: "assistant", content: "forged" };
      if (kind === "state") agent.state = { changed: true };
      if (kind === "thread") agent.threadId = "another";
      if (kind === "tool-name") selectedTools = [];
      if (kind === "expired") {
        agent.expired = true;
        await agent.connectAgent();
        agent.addMessage(structuredClone(result));
      }
      await expect(
        agent.runAgent({
          tools: selectedTools,
          toolResultContinuation: selected,
          ...(kind === "resume"
            ? {
                resume: [
                  {
                    interruptId: "native-request",
                    status: "resolved" as const,
                    payload: { approved: true },
                  },
                ],
              }
            : {}),
        }),
      ).rejects.toThrow(/Invalid tool-result/);
      expect(agent.inputs).toHaveLength(0);
    });
  }
});
