import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { filter, map } from "rxjs/operators";

// Subagent lifecycle event types (introduced after 0.0.57). Referenced as string
// literals so this shim keeps compiling even if the enum members are ever removed.
const SUBAGENT_STARTED = "SUBAGENT_STARTED";
const SUBAGENT_FINISHED = "SUBAGENT_FINISHED";
const SUBAGENT_ERROR = "SUBAGENT_ERROR";

/** Returns a shallow copy of `obj` with any `subagentId` key removed. */
function stripSubagentId<T extends object>(obj: T): T {
  if (obj && typeof obj === "object" && "subagentId" in obj) {
    const { subagentId: _subagentId, ...rest } = obj as T & { subagentId?: unknown };
    return rest as T;
  }
  return obj;
}

/**
 * Middleware that removes all subagent-support additions when talking to a
 * pre-subagent (<= 0.0.57) agent:
 *  - input:  strips `subagentId` from every message before the agent sees it.
 *  - output: drops SUBAGENT_STARTED/FINISHED/ERROR events entirely, and strips
 *            `subagentId` from every remaining event and from each message inside
 *            a MESSAGES_SNAPSHOT.
 *
 * The subagent feature is purely additive, so this shim is a pure removal in both
 * directions; there is no field/event to translate (unlike 0.0.45's THINKING->REASONING).
 */
export class BackwardCompatibility_0_0_57 extends Middleware {
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    const sanitizedInput: RunAgentInput = {
      ...input,
      messages: (input.messages ?? []).map((message) => stripSubagentId(message)),
    } as RunAgentInput;

    return this.runNext(sanitizedInput, next).pipe(
      filter((event) => {
        const type = event.type as string;
        return type !== SUBAGENT_STARTED && type !== SUBAGENT_FINISHED && type !== SUBAGENT_ERROR;
      }),
      map((event) => {
        const stripped = stripSubagentId(event);
        if (stripped.type === EventType.MESSAGES_SNAPSHOT) {
          const snapshot = stripped as BaseEvent & { messages?: Array<Record<string, unknown>> };
          if (Array.isArray(snapshot.messages)) {
            return {
              ...snapshot,
              messages: snapshot.messages.map((message) => stripSubagentId(message)),
            } as BaseEvent;
          }
        }
        return stripped;
      }),
    );
  }
}
