import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { transformChunks } from "@/chunks";
import { randomUUID } from "@/utils";

// Event type strings for THINKING events (deprecated)
const THINKING_START = "THINKING_START";
const THINKING_END = "THINKING_END";
const THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START";
const THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT";
const THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END";

function warnAboutTransformation(from: string, to: string) {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    process.env.SUPPRESS_TRANSFORMATION_WARNINGS
  )
    return;
  console.warn(
    `AG-UI is converting ${from} to ${to}. To remove this warning, upgrade your AG-UI integration package (e.g. @ag-ui/langgraph). To surpress it, set SUPPRESS_TRANSFORMATION_WARNINGS=true in your .env file.`,
  );
}

/**
 * Creates a stateful mapper that rewrites deprecated legacy THINKING events into
 * their REASONING replacements. The THINKING_* event types were removed from the
 * protocol in 1.0.0; this keeps backward compatibility for legacy agents that
 * still emit them on the wire.
 *
 * The mapper is stateful (it remembers the generated reasoning/message ids across
 * a START → … → END sequence), so create a fresh one per run/stream.
 *
 * Event mapping:
 * - THINKING_START → REASONING_START
 * - THINKING_TEXT_MESSAGE_START → REASONING_MESSAGE_START
 * - THINKING_TEXT_MESSAGE_CONTENT → REASONING_MESSAGE_CONTENT
 * - THINKING_TEXT_MESSAGE_END → REASONING_MESSAGE_END
 * - THINKING_END → REASONING_END
 *
 * Non-THINKING events pass through unchanged.
 */
export function createLegacyThinkingMapper(): (event: BaseEvent) => BaseEvent {
  let currentReasoningId: string | null = null;
  let currentMessageId: string | null = null;

  return (event: BaseEvent): BaseEvent => {
    switch (event.type as string) {
      case THINKING_START: {
        currentReasoningId = randomUUID();
        const { title, ...rest } = event as BaseEvent & { title?: string };
        warnAboutTransformation(THINKING_START, EventType.REASONING_START);
        return {
          ...rest,
          type: EventType.REASONING_START,
          messageId: currentReasoningId,
        };
      }

      case THINKING_TEXT_MESSAGE_START: {
        currentMessageId = randomUUID();
        warnAboutTransformation(THINKING_TEXT_MESSAGE_START, EventType.REASONING_MESSAGE_START);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_START,
          messageId: currentMessageId,
          role: "reasoning" as const,
        };
      }

      case THINKING_TEXT_MESSAGE_CONTENT: {
        const { delta, ...rest } = event as BaseEvent & { delta: string };
        warnAboutTransformation(THINKING_TEXT_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_CONTENT);
        return {
          ...rest,
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: currentMessageId ?? randomUUID(),
          delta,
        };
      }

      case THINKING_TEXT_MESSAGE_END: {
        const messageId = currentMessageId ?? randomUUID();
        warnAboutTransformation(THINKING_TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_END);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_END,
          messageId,
        };
      }

      case THINKING_END: {
        const reasoningId = currentReasoningId ?? randomUUID();
        warnAboutTransformation(THINKING_END, EventType.REASONING_END);
        return {
          ...event,
          type: EventType.REASONING_END,
          messageId: reasoningId,
        };
      }

      default:
        return event;
    }
  };
}

/**
 * Middleware that maps deprecated THINKING events to the new REASONING events.
 *
 * This ensures backward compatibility for agents that still emit legacy THINKING
 * events by transforming them into the corresponding REASONING events. The HTTP
 * transport applies the same mapping pre-validation (see {@link createLegacyThinkingMapper});
 * this middleware covers non-HTTP agents that emit THINKING events directly.
 */
export class BackwardCompatibility_0_0_45 extends Middleware {
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Fresh mapper state for each run.
    const mapEvent = createLegacyThinkingMapper();
    // Translate legacy THINKING events to REASONING *before* chunk transformation.
    // transformChunks no longer recognizes the removed THINKING_* types and would
    // otherwise drop them at its exhaustiveness fallthrough.
    return next.run(input).pipe(map(mapEvent), transformChunks(false));
  }
}
