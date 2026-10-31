import { describe, expect, it } from "vitest";
import { of } from "rxjs";
import { AbstractAgent } from "../agent";
import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type ResumeEntry,
} from "@ag-ui/core";

const history: Message[] = [
  {
    id: "calls",
    role: "assistant",
    toolCalls: ["one", "two"].map((id) => ({
      id: `call-${id}`,
      type: "function",
      function: { name: "protected", arguments: "{}" },
    })),
  },
];
const approve: ResumeEntry = {
  interruptId: "request-one",
  status: "resolved",
  payload: { approved: true },
};
class Agent extends AbstractAgent {
  inputs: RunAgentInput[] = [];
  expired = false;
  serverOwned = true;
  run(input: RunAgentInput) {
    this.inputs.push(input);
    return of(...this.events(input));
  }
  protected connect(input: RunAgentInput) {
    return of(...this.events(input));
  }
  private events(input: RunAgentInput): BaseEvent[] {
    const remaining = ["one", "two"].filter(
      (id) => !input.resume?.some((r) => r.interruptId === `request-${id}`),
    );
    return [
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
      { type: EventType.MESSAGES_SNAPSHOT, messages: history },
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: {
          type: "interrupt",
          interrupts: remaining.map((id) => ({
            id: `request-${id}`,
            reason: "tool_call",
            toolCallId: `call-${id}`,
            ...(this.serverOwned ? { metadata: { "ag-ui:tool-execution": "server" } } : {}),
            ...(this.expired ? { expiresAt: "2000-01-01T00:00:00Z" } : {}),
          })),
        },
      },
    ];
  }
}
async function ready(enabled = true) {
  const agent = new Agent({ allowPartialNativeApprovals: enabled });
  await agent.connectAgent();
  return agent;
}
describe("explicit partial native approvals", () => {
  it("sends one real approval with empty messages while the other request remains pending", async () => {
    const agent = await ready();
    await agent.runAgent({ nativeApprovalContinuation: [approve] });
    expect(agent.inputs[0]?.resume).toEqual([approve]);
    expect(agent.inputs[0]?.messages).toEqual([]);
    expect(agent.messages).toEqual(history);
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["request-two"]);
    await expect(agent.runAgent({ nativeApprovalContinuation: [approve] })).rejects.toThrow(
      /Invalid native-approval/,
    );
  });
  it("keeps default full coverage and disabled capability guards", async () => {
    await expect((await ready()).runAgent({ resume: [approve] })).rejects.toThrow(
      /pending interrupt/,
    );
    await expect(
      (await ready(false)).runAgent({ nativeApprovalContinuation: [approve] }),
    ).rejects.toThrow(/Invalid native-approval/);
  });
  it("retains trusted checkpoint through clone", async () => {
    const agent = (await ready()).clone();
    agent.inputs = [];
    await agent.runAgent({ nativeApprovalContinuation: [approve] });
    expect(agent.inputs[0]?.resume).toEqual([approve]);
  });
});

describe("native decision authority boundaries", () => {
  it.each<[string, ResumeEntry[]]>([
    ["unknown", [{ ...approve, interruptId: "unknown" }]],
    ["duplicate", [approve, approve]],
    ["empty", []],
    ["non-boolean", [{ ...approve, payload: { approved: "yes" } }]],
    ["extra payload", [{ ...approve, payload: { approved: true, injected: true } }]],
  ])("rejects %s responses", async (_name, responses) => {
    const agent = await ready();
    await expect(agent.runAgent({ nativeApprovalContinuation: responses })).rejects.toThrow();
    expect(agent.inputs).toHaveLength(0);
  });
  it("rejects unmarked requests and constructor-forged pending history", async () => {
    const agent = new Agent({ allowPartialNativeApprovals: true });
    agent.serverOwned = false;
    await agent.connectAgent();
    await expect(agent.runAgent({ nativeApprovalContinuation: [approve] })).rejects.toThrow();
    const forged = new Agent({ allowPartialNativeApprovals: true, initialMessages: history });
    forged.pendingInterrupts = [
      {
        id: "request-one",
        reason: "tool_call",
        toolCallId: "call-one",
        metadata: { "ag-ui:tool-execution": "server" },
      },
    ];
    await expect(forged.runAgent({ nativeApprovalContinuation: [approve] })).rejects.toThrow();
  });
  it.each(["thread", "messages", "state", "capability"])("rejects changed %s", async (field) => {
    const agent = await ready();
    if (field === "thread") agent.threadId = "other";
    if (field === "messages") agent.addMessage({ id: "extra", role: "user", content: "injected" });
    if (field === "state") agent.state = { altered: true };
    if (field === "capability") agent.allowPartialNativeApprovals = false;
    await expect(agent.runAgent({ nativeApprovalContinuation: [approve] })).rejects.toThrow();
    expect(agent.inputs).toHaveLength(0);
  });
  it("rejects expired approval but allows explicit cancellation", async () => {
    const agent = new Agent({ allowPartialNativeApprovals: true });
    agent.expired = true;
    await agent.connectAgent();
    await expect(agent.runAgent({ nativeApprovalContinuation: [approve] })).rejects.toThrow();
    await agent.runAgent({
      nativeApprovalContinuation: [{ interruptId: approve.interruptId, status: "cancelled" }],
    });
    expect(agent.inputs[0]?.messages).toEqual([]);
  });
  it("rechecks input after initialization subscribers", async () => {
    const agent = await ready();
    await expect(
      agent.runAgent(
        { nativeApprovalContinuation: [approve] },
        {
          onRunInitialized: () => ({
            messages: [{ id: "injected", role: "user", content: "bad" }],
          }),
        },
      ),
    ).rejects.toThrow();
    expect(agent.inputs).toHaveLength(0);
  });
});
