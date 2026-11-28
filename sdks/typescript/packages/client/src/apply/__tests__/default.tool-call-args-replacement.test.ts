import { firstValueFrom, of, toArray } from "rxjs";
import { vi } from "vitest";
import { AssistantMessage, BaseEvent, EventType, Message, RunAgentInput } from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";
import { AgentSubscriber } from "@/agent/subscriber";

// https://github.com/ag-ui-protocol/ag-ui/issues/3264
describe("TOOL_CALL_ARGS when a subscriber replaces messages", () => {
  const initialMessages = (): Message[] => [
    {
      id: "owner",
      role: "assistant",
      toolCalls: [{ id: "c", type: "function", function: { name: "f", arguments: "" } }],
    },
  ];

  const argsEvents = (...deltas: string[]): BaseEvent[] => [
    { type: EventType.TOOL_CALL_START, toolCallId: "c", toolCallName: "f" } as BaseEvent,
    ...deltas.map(
      (delta) => ({ type: EventType.TOOL_CALL_ARGS, toolCallId: "c", delta }) as BaseEvent,
    ),
  ];

  const run = async (
    events: BaseEvent[],
    subscribers: AgentSubscriber[],
    messages: Message[] = initialMessages(),
  ) => {
    const input: RunAgentInput = {
      messages,
      state: {},
      threadId: "t",
      runId: "r",
      tools: [],
      context: [],
    };
    const agent = { messages, state: {} } as unknown as AbstractAgent;
    const updates = await firstValueFrom(
      defaultApplyEvents(input, of(...events), agent, subscribers).pipe(toArray()),
    );
    return updates.at(-1)!.messages!;
  };

  const owner = (messages: readonly Message[]) => {
    const message = messages.find((m) => m.id === "owner");
    if (!message || message.role !== "assistant") throw new Error("missing owner");
    return message as AssistantMessage;
  };

  const replaceOnce = (edit: (next: Message[]) => void): AgentSubscriber => {
    let first = true;
    return {
      onToolCallArgsEvent: ({ messages }) => {
        if (!first) return;
        first = false;
        const next = structuredClone(messages) as Message[];
        edit(next);
        return { messages: next };
      },
    };
  };

  it("applies the accepted chunk to the replacement array", async () => {
    const messages = await run(argsEvents('{"new":', "1}"), [
      replaceOnce((next) => {
        next[0] = { ...next[0], content: "subscriber edit" } as Message;
      }),
    ]);

    expect(owner(messages).content).toBe("subscriber edit");
    expect(owner(messages).toolCalls![0].function.arguments).toBe('{"new":1}');
  });

  it("applies every chunk when the subscriber replaces messages on each one", async () => {
    const buffers: string[] = [];
    const messages = await run(argsEvents('{"a":', "1,", '"b":2}'), [
      {
        onToolCallArgsEvent: ({ messages, toolCallBuffer }) => {
          buffers.push(toolCallBuffer);
          return { messages: structuredClone(messages) as Message[] };
        },
      },
    ]);

    expect(owner(messages).toolCalls![0].function.arguments).toBe('{"a":1,"b":2}');
    expect(buffers).toEqual(["", '{"a":', '{"a":1,']);
  });

  it("keeps the replacement and drops the chunk when the subscriber stops propagation", async () => {
    const messages = await run(argsEvents('{"new":1}'), [
      {
        onToolCallArgsEvent: ({ messages }) => {
          const next = structuredClone(messages) as Message[];
          next[0] = { ...next[0], content: "subscriber edit" } as Message;
          return { messages: next, stopPropagation: true };
        },
      },
    ]);

    expect(owner(messages).content).toBe("subscriber edit");
    expect(owner(messages).toolCalls![0].function.arguments).toBe("");
  });

  it("does not write to the discarded call when the replacement removes it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const messages = await run(argsEvents('{"new":1}'), [
        replaceOnce((next) => {
          next[0] = { ...next[0], toolCalls: [] } as Message;
        }),
      ]);

      expect(owner(messages).toolCalls).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("TOOL_CALL_ARGS: Tool call 'c' was removed by a subscriber"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("lets a later subscriber see the earlier subscriber's replacement", async () => {
    const seen: string[] = [];
    const messages = await run(argsEvents('{"new":1}'), [
      replaceOnce((next) => {
        next[0] = { ...next[0], content: "first" } as Message;
      }),
      {
        onToolCallArgsEvent: ({ messages }) => {
          seen.push(String(owner(messages).content));
        },
      },
    ]);

    expect(seen).toEqual(["first"]);
    expect(owner(messages).content).toBe("first");
    expect(owner(messages).toolCalls![0].function.arguments).toBe('{"new":1}');
  });

  // A TOOL_CALL_START for a call already in history (a replay) marks its saved
  // arguments for replacement by the first accepted chunk.
  describe("when the call is replayed", () => {
    const savedMessages = (): Message[] => [
      {
        id: "owner",
        role: "assistant",
        toolCalls: [
          { id: "c", type: "function", function: { name: "f", arguments: '{"old":true}' } },
        ],
      },
    ];

    it("replaces the saved arguments in the replacement array", async () => {
      const messages = await run(
        argsEvents('{"new":', "1}"),
        [
          replaceOnce((next) => {
            next[0] = { ...next[0], content: "subscriber edit" } as Message;
          }),
        ],
        savedMessages(),
      );

      expect(owner(messages).content).toBe("subscriber edit");
      expect(owner(messages).toolCalls![0].function.arguments).toBe('{"new":1}');
    });

    it("replaces once, then appends, when the subscriber replaces messages on every chunk", async () => {
      // The replace marker is used up by the write that lands on the retained
      // call, not by the discarded one, so the saved arguments never leak in.
      const messages = await run(
        argsEvents('{"new":', "1}"),
        [
          {
            onToolCallArgsEvent: ({ messages }) => ({
              messages: structuredClone(messages) as Message[],
            }),
          },
        ],
        savedMessages(),
      );

      expect(owner(messages).toolCalls![0].function.arguments).toBe('{"new":1}');
    });
  });
});
