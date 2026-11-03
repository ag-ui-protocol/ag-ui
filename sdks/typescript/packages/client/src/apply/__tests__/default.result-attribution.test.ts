import { firstValueFrom, from, toArray } from "rxjs";
import { BaseEvent, EventType, RunAgentInput, TextMessageStartEvent } from "@ag-ui/core";
import { HttpAgent } from "@/agent";
import { verifyEvents } from "@/verify/verify";
import { defaultApplyEvents } from "../default";

it.each([undefined, "child", "other-child"])(
  "replaces result attribution with %s consistently with verification",
  async (subagentRunId) => {
    const input: RunAgentInput = {
      threadId: "thread",
      runId: "run",
      state: {},
      tools: [],
      context: [],
      messages: [
        { id: "before", role: "user", content: "Question" },
        {
          id: "result",
          role: "tool",
          toolCallId: "call",
          content: "old",
          subagentRunId: "child",
          metadata: { source: "before-pause", custom: { retained: true } },
        },
        { id: "after", role: "assistant", content: "Done" },
      ],
    };
    const original = structuredClone(input.messages);
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId, input },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "result",
        toolCallId: "call",
        content: "corrected",
        ...(subagentRunId !== undefined && { subagentRunId }),
      },
    ];
    const agent = new HttpAgent({ url: "https://example.com", initialMessages: original });
    const updates = await firstValueFrom(
      defaultApplyEvents(input, from(events).pipe(verifyEvents(false)), agent, []).pipe(toArray()),
    );
    const messages = updates.filter((update) => update.messages).at(-1)!.messages!;
    expect(messages.map((message) => message.id)).toEqual(["before", "result", "after"]);
    expect(messages[0]).toEqual(original[0]);
    expect(messages[2]).toEqual(original[2]);
    expect(messages[1]).toEqual({
      id: "result",
      role: "tool",
      toolCallId: "call",
      content: "corrected",
      metadata: original[1]!.metadata,
      ...(subagentRunId !== undefined && { subagentRunId }),
    });
    if (subagentRunId === undefined) expect(messages[1]).not.toHaveProperty("subagentRunId");
    expect(input.messages).toEqual(original);

    const reopen = (owner: string | undefined): TextMessageStartEvent => ({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "result",
      role: "assistant",
      ...(owner !== undefined && { subagentRunId: owner }),
    });
    // Both the live verifier and a new verifier seeded from stored history must
    // accept the corrected owner and reject a different explicit owner.
    for (const history of [events, [events[0]!, { type: EventType.MESSAGES_SNAPSHOT, messages }]]) {
      await expect(
        firstValueFrom(
          from([...history, reopen(subagentRunId)]).pipe(verifyEvents(false), toArray()),
        ),
      ).resolves.toHaveLength(history.length + 1);
      await expect(
        firstValueFrom(
          from([...history, reopen(subagentRunId === "child" ? "other-child" : "child")]).pipe(
            verifyEvents(false),
            toArray(),
          ),
        ),
      ).rejects.toThrow(/does not match/);
    }
  },
);
