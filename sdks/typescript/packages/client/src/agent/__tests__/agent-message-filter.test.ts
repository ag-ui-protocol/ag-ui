/**
 * AgentConfig.messageFilter: shapes the outgoing RunAgentInput.messages
 * without touching agent.messages. Re-implements ag-ui-protocol/ag-ui#2063.
 */
import { AbstractAgent } from "../agent";
import { HttpAgent } from "../http";
import { BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { EMPTY, Observable, of } from "rxjs";

class RecordingAgent extends AbstractAgent {
  public capturedMessages: Message[][] = [];

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.capturedMessages.push(structuredClone(input.messages));
    return EMPTY as Observable<BaseEvent>;
  }
}

const userMsg = (id: string, content: string): Message => ({ id, role: "user", content });

const assistantMsg = (id: string, content: string): Message => ({
  id,
  role: "assistant",
  content,
});

describe("AgentConfig.messageFilter", () => {
  it("forwards all messages when messageFilter is not set", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "hello"), assistantMsg("a1", "hi"), userMsg("u2", "bye")],
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0]).toHaveLength(3);
  });

  it("applies messageFilter before forwarding messages to run()", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "hello"), assistantMsg("a1", "hi"), userMsg("u2", "latest")],
      messageFilter: (messages) => {
        const last = [...messages].reverse().find((m) => m.role === "user");
        return last ? [last] : [];
      },
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0]).toHaveLength(1);
    expect(agent.capturedMessages[0][0]).toMatchObject({ id: "u2", role: "user" });
  });

  it("does not mutate the agent's stored messages", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "a"), userMsg("u2", "b"), userMsg("u3", "c")],
      messageFilter: (messages) => messages.slice(-1),
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0]).toHaveLength(1);
    expect(agent.messages.map((m) => m.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("receives a copy, so an in-place edit by the filter cannot reach agent.messages", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "original")],
      messageFilter: (messages) => {
        (messages[0] as { content: string }).content = "edited";
        return messages;
      },
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0][0]).toMatchObject({ content: "edited" });
    expect(agent.messages[0]).toMatchObject({ content: "original" });
  });

  it("excludes activity messages before passing to messageFilter", async () => {
    const activityMsg = {
      id: "act1",
      role: "activity",
      activityType: "progress",
      content: { text: "thinking" },
    } as Message;
    const seen: Message[][] = [];

    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "hello"), activityMsg, userMsg("u2", "world")],
      messageFilter: (messages) => {
        seen.push([...messages]);
        return messages;
      },
    });

    await agent.runAgent();

    expect(seen[0].every((m) => m.role !== "activity")).toBe(true);
    expect(seen[0]).toHaveLength(2);
  });

  it("is re-applied when onRunInitialized replaces the messages", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "a")],
      messageFilter: (messages) => messages.slice(-1),
    });
    agent.subscribe({
      onRunInitialized: ({ messages }) => ({
        messages: [...messages, userMsg("u2", "added by subscriber")],
      }),
    });

    await agent.runAgent();

    expect(agent.capturedMessages[0].map((m) => m.id)).toEqual(["u2"]);
    expect(agent.messages.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("runs at the transport, so middlewares see the unfiltered messages", async () => {
    const agent = new RecordingAgent({
      initialMessages: [userMsg("u1", "a"), userMsg("u2", "b")],
      messageFilter: (messages) => messages.slice(-1),
    });
    const seenByMiddleware: string[][] = [];
    agent.use((input, next) => {
      seenByMiddleware.push(input.messages.map((m) => m.id));
      return next.run(input);
    });

    await agent.runAgent();

    expect(seenByMiddleware).toEqual([["u1", "u2"]]);
    expect(agent.capturedMessages[0].map((m) => m.id)).toEqual(["u2"]);
  });

  it("preserves messageFilter across clone()", async () => {
    const original = new RecordingAgent({
      initialMessages: [userMsg("u1", "a"), userMsg("u2", "b")],
      messageFilter: (messages) => messages.slice(-1),
    });

    const cloned = original.clone() as RecordingAgent;
    cloned.capturedMessages = [];
    await cloned.runAgent();

    expect(cloned.capturedMessages[0].map((m) => m.id)).toEqual(["u2"]);
  });

  it("HttpAgent accepts messageFilter and keeps it across clone()", async () => {
    const bodies: RunAgentInput[] = [];
    const agent = new HttpAgent({
      url: "https://example.com/agent",
      initialMessages: [userMsg("u1", "first"), userMsg("u2", "second")],
      messageFilter: (messages) => messages.slice(-1),
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        throw new Error("not reachable in this test");
      },
    });
    agent.debug = false;

    const cloned = agent.clone();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await cloned.runAgent().catch(() => undefined);
    } finally {
      errorSpy.mockRestore();
    }

    expect(bodies[0].messages.map((m) => m.id)).toEqual(["u2"]);
  });

  it("does not affect what the run reports as new messages", async () => {
    class ReplyingAgent extends AbstractAgent {
      run(input: RunAgentInput): Observable<BaseEvent> {
        return of(
          { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "a1",
            role: "assistant",
          },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "a1", delta: "hi" },
          { type: EventType.TEXT_MESSAGE_END, messageId: "a1" },
          { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId },
        ) as Observable<BaseEvent>;
      }
    }
    const agent = new ReplyingAgent({
      initialMessages: [userMsg("u1", "a"), userMsg("u2", "b")],
      messageFilter: () => [],
    });

    const result = await agent.runAgent();

    expect(result.newMessages.map((m) => m.id)).toEqual(["a1"]);
    expect(agent.messages.map((m) => m.id)).toEqual(["u1", "u2", "a1"]);
  });
});
