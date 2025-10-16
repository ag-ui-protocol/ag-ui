import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  BaseEvent,
  EventType,
  MessagesSnapshotEvent,
  RunAgentInput,
  Message,
  TextMessageContentEvent,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

const FAKE_AGENT = null as unknown as AbstractAgent;

describe("defaultApplyEvents multimodal messages", () => {
  it("retains multimodal content from message snapshots", async () => {
    const snapshotMessages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        content: [
          {
            type: "binary",
            mimeType: "image/png",
            data: "base64:screenshot",
          },
        ],
      },
    ];

    const events$ = new Subject<BaseEvent>();
    const initialInput: RunAgentInput = {
      threadId: "thread",
      runId: "run",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };

    const result$ = defaultApplyEvents(initialInput, events$, FAKE_AGENT, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: snapshotMessages,
    } as MessagesSnapshotEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    expect(stateUpdates.length).toBe(1);
    const message = stateUpdates[0].messages?.[0] as Message;
    expect(Array.isArray(message.content)).toBe(true);
    expect((message.content as any[])[0]).toMatchObject({ mimeType: "image/png" });
  });

  it("appends streamed text while preserving binary items", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialInput: RunAgentInput = {
      threadId: "thread",
      runId: "run",
      messages: [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    };

    const result$ = defaultApplyEvents(initialInput, events$, FAKE_AGENT, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "msg-attachment",
          role: "user",
          content: [
            { type: "text", text: "Initial" },
            {
              type: "binary",
              mimeType: "text/csv",
              data: "YSxiLGM=",
            },
          ],
        },
      ],
    } as MessagesSnapshotEvent);

    events$.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-attachment",
      delta: " update",
    } as TextMessageContentEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;
    const finalMessage = stateUpdates[stateUpdates.length - 1].messages?.[0] as Message;

    expect(Array.isArray(finalMessage.content)).toBe(true);
    const [textPart, binaryPart] = finalMessage.content as any[];
    expect(textPart.text).toBe("Initial update");
    expect(binaryPart.mimeType).toBe("text/csv");
  });
});
