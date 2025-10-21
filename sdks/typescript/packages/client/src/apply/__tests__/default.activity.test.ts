import { Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  BaseEvent,
  EventType,
  RunAgentInput,
} from "@ag-ui/core";
import { defaultApplyEvents } from "../default";
import { AbstractAgent } from "@/agent";

const FAKE_AGENT = null as unknown as AbstractAgent;

describe("defaultApplyEvents with activity events", () => {
  it("creates and updates activity messages via snapshot and delta", async () => {
    const events$ = new Subject<BaseEvent>();
    const initialState: RunAgentInput = {
      messages: [],
      state: {},
      threadId: "thread-activity",
      runId: "run-activity",
      tools: [],
      context: [],
    };

    const result$ = defaultApplyEvents(initialState, events$, FAKE_AGENT, []);
    const stateUpdatesPromise = firstValueFrom(result$.pipe(toArray()));

    events$.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "PLAN",
      content: { tasks: ["search"] },
    } as ActivitySnapshotEvent);

    events$.next({
      type: EventType.ACTIVITY_DELTA,
      messageId: "activity-1",
      activityType: "PLAN",
      patch: [{ op: "replace", path: "/content/tasks/0", value: "✓ search" }],
    } as ActivityDeltaEvent);

    events$.complete();

    const stateUpdates = await stateUpdatesPromise;

    expect(stateUpdates.length).toBe(2);

    const snapshotUpdate = stateUpdates[0];
    expect(snapshotUpdate?.messages?.[0]?.role).toBe("activity");
    expect(snapshotUpdate?.messages?.[0]?.activityType).toBe("PLAN");
    expect(snapshotUpdate?.messages?.[0]?.content).toEqual({ tasks: ["search"] });

    const deltaUpdate = stateUpdates[1];
    expect(deltaUpdate?.messages?.[0]?.content).toEqual({ tasks: ["✓ search"] });
  });
});
