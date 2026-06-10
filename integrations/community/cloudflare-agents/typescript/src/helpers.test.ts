import { describe, it, expect } from "vitest";
import { createSSEResponse, createNDJSONResponse } from "./helpers";
import { Observable } from "rxjs";
import { EventType, type BaseEvent } from "@ag-ui/client";

describe("createSSEResponse", () => {
  it("streams events as SSE format", async () => {
    const events$ = new Observable<BaseEvent>((sub) => {
      sub.next({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1", timestamp: 1000 } as BaseEvent);
      sub.complete();
    });
    const resp = createSSEResponse(events$);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await resp.text();
    expect(text).toContain("data: ");
    expect(text).toContain("RUN_STARTED");
  });

  it("emits RUN_ERROR on stream error", async () => {
    const events$ = new Observable<BaseEvent>((sub) => {
      sub.next({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1", timestamp: 1000 } as BaseEvent);
      sub.error(new Error("upstream broke"));
    });
    const text = await createSSEResponse(events$).text();
    expect(text).toContain("RUN_ERROR");
    expect(text).toContain("upstream broke");
  });
});

describe("createNDJSONResponse", () => {
  it("streams events as NDJSON format", async () => {
    const events$ = new Observable<BaseEvent>((sub) => {
      sub.next({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1", timestamp: 1000 } as BaseEvent);
      sub.complete();
    });
    const resp = createNDJSONResponse(events$);
    expect(resp.headers.get("Content-Type")).toBe("application/x-ndjson");
    const parsed = JSON.parse((await resp.text()).trim().split("\n")[0]);
    expect(parsed.type).toBe("RUN_STARTED");
  });

  it("emits RUN_ERROR on stream error", async () => {
    const events$ = new Observable<BaseEvent>((sub) => { sub.error(new Error("failed")); });
    const text = await createNDJSONResponse(events$).text();
    expect(text).toContain("RUN_ERROR");
  });
});
