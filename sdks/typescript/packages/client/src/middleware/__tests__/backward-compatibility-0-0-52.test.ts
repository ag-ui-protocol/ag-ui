import { describe, expect, it } from "vitest";
import { of, toArray, firstValueFrom } from "rxjs";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { BackwardCompatibility_0_0_52 } from "../backward-compatibility-0-0-52";

describe("BackwardCompatibility_0_0_52", () => {
  const mw = new BackwardCompatibility_0_0_52();

  it("injects outcome='success' on RUN_FINISHED events missing outcome", async () => {
    const input$ = of({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      result: { ok: true },
    } as BaseEvent);
    const out = await firstValueFrom(mw.transformEvents(input$).pipe(toArray()));
    expect((out[0] as any).outcome).toBe("success");
    expect((out[0] as any).result).toEqual({ ok: true });
  });

  it("leaves RUN_FINISHED events with outcome untouched", async () => {
    const original = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "interrupt",
      interrupts: [{ id: "int-1", reason: "tool_call" }],
    } as unknown as BaseEvent;
    const out = await firstValueFrom(mw.transformEvents(of(original)).pipe(toArray()));
    expect(out[0]).toEqual(original);
  });

  it("leaves non-RUN_FINISHED events untouched", async () => {
    const original = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m-1",
      role: "assistant",
    } as BaseEvent;
    const out = await firstValueFrom(mw.transformEvents(of(original)).pipe(toArray()));
    expect(out[0]).toEqual(original);
  });
});
