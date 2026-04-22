import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";

/**
 * Normalizes RUN_FINISHED events emitted by producers at or below version 0.0.52
 * that did not yet set the `outcome` field introduced in the interrupt-aware run
 * lifecycle. Missing `outcome` is treated as `"success"` — the only outcome
 * producers at that version were capable of expressing.
 */
export class BackwardCompatibility_0_0_52 extends Middleware {
  transformEvents<T extends BaseEvent>(events$: Observable<T>): Observable<T> {
    return events$.pipe(
      map((event) => {
        if (event.type === EventType.RUN_FINISHED && (event as any).outcome === undefined) {
          return { ...event, outcome: "success" } as T;
        }
        return event;
      }),
    );
  }

  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.transformEvents(this.runNext(input, next));
  }
}
