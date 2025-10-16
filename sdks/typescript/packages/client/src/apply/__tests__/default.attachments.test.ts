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

describe("defaultApplyEvents attachments", () => {
  it("retains attachments from message snapshots", async () => {
    const attachments = [
      {
        url: "data:image/png;base64,somepngbytes",
      },
    ];

    const snapshotMessages: Message[] = [
      {
        id: "msg-1",
        role: "user",
        attachments,
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
    expect(message.attachments).toEqual(attachments);
  });

  it("keeps attachments when message content updates", async () => {
    const attachments = [
      {
        url: "data:text/csv;base64,YSwxLDM=",
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
      messages: [
        {
          id: "msg-attachment",
          role: "user",
          content: "Initial",
          attachments,
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
    expect(finalMessage.attachments).toEqual(attachments);
    expect(finalMessage.content).toBe("Initial update");
  });
});
