import { Middleware, type MiddlewareNext } from "./middleware";
import type { RunAgentInput, BaseEvent, Message } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { defer, type Observable } from "rxjs";
import { map } from "rxjs/operators";
import { randomUUID } from "@/utils";
import { upgradeMessageContent } from "./legacy-content";
import { warnCompatibility } from "./compat-warning";

// Deprecated inbound shapes, retired from the 1.0 contract. Each entry here
// has a row in the repo-root DEPRECATIONS.md — not this package's own
// DEPRECATIONS.md, which tracks a different set under a different schema —
// with its replacement and expiry date.
const THINKING_START = "THINKING_START";
const THINKING_END = "THINKING_END";
const THINKING_TEXT_MESSAGE_START = "THINKING_TEXT_MESSAGE_START";
const THINKING_TEXT_MESSAGE_CONTENT = "THINKING_TEXT_MESSAGE_CONTENT";
const THINKING_TEXT_MESSAGE_END = "THINKING_TEXT_MESSAGE_END";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every whole optional field the client reads as absent when a producer sends
 * it as `null`, by where the field sits. This table is the complete list and
 * drives every optional-null conversion below: a null in any other optional
 * field stays for validation to reject, and nulls inside application data
 * (state, metadata values, `rawEvent` and `result` contents, tool arguments)
 * are never touched. Each entry has a row in the repo-root DEPRECATIONS.md.
 *
 * Only the named fields are read, so the per-event cost is a few property
 * lookups; nothing walks the payload.
 */
const OPTIONAL_NULLS = {
  /** On any event. */
  event: ["rawEvent", "subagentRunId"],
  /** On the event type of the same name. */
  [EventType.RUN_STARTED]: ["parentRunId", "input"],
  [EventType.RUN_FINISHED]: ["result", "outcome"],
  [EventType.RUN_ERROR]: ["usage"],
  [EventType.SUBAGENT_FINISHED]: ["result"],
  [EventType.TOOL_CALL_START]: ["parentMessageId"],
  [EventType.TOOL_CALL_CHUNK]: ["parentMessageId"],
  [EventType.TOOL_CALL_RESULT]: ["role"],
  "RUN_FINISHED.outcome": ["pendingToolCallIds"],
  "RUN_FINISHED.usage[]": [
    "provider",
    "reasoningTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
  ],
  /** Inside a RunAgentInput (here: RUN_STARTED.input). */
  RunAgentInput: ["forwardedProps"],
  Tool: ["parameters"],
  ResumeEntry: ["payload"],
  /** On an image, audio, video or document content part. */
  "input content": ["metadata"],
} as const satisfies Record<string, ReadonlyArray<string>>;

/** The table's event-type rows, for the one lookup each event costs. */
const EVENT_TYPE_OPTIONAL_NULLS: ReadonlyMap<string, ReadonlyArray<string>> = new Map(
  Object.entries(OPTIONAL_NULLS).filter(([location]) =>
    (Object.values(EventType) as string[]).includes(location),
  ),
);

/** Announces one converted null; `what` names the field and where it sat. */
type NullNotice = (what: string) => void;

const noticeEveryNull: NullNotice = (what) => warnCompatibility(what, "an absent field");

/**
 * `value` without those of `fields` that are `null`, announcing each one.
 * `label` names the location (none for the fields allowed on any event).
 * Returns `value` itself when nothing was null and never mutates it.
 */
function omitOptionalNulls<T>(
  value: T,
  fields: ReadonlyArray<string>,
  label: string | undefined,
  notice: NullNotice,
): T {
  if (!isRecord(value)) return value;
  let rest: Record<string, unknown> | undefined;
  for (const field of fields) {
    if (value[field] !== null) continue;
    notice(label === undefined ? `${field}: null` : `${label}.${field}: null`);
    rest ??= { ...value };
    delete rest[field];
  }
  return (rest ?? value) as T;
}

function mapProtocolArray(
  value: unknown,
  field: string,
  normalize: (entry: unknown) => unknown,
): unknown {
  if (!isRecord(value) || !Array.isArray(value[field])) return value;
  const original = value[field];
  const entries = original.map(normalize);
  return entries.some((entry, index) => entry !== original[index])
    ? { ...value, [field]: entries }
    : value;
}

function normalizeLegacyMessageNulls(message: unknown, notice: NullNotice): unknown {
  return mapProtocolArray(message, "content", (part) => {
    if (!isRecord(part)) return part;
    switch (part.type) {
      case "image":
      case "audio":
      case "video":
      case "document":
        return omitOptionalNulls(
          part,
          OPTIONAL_NULLS["input content"],
          `${part.type} input content`,
          notice,
        );
      default:
        return part;
    }
  });
}

/**
 * Normalize only whole optional nulls accepted by pre-1.0 request parsers.
 * Used internally for RUN_STARTED.input; direct server request parsers do not
 * pass through this event boundary and must handle compatibility locally.
 * This does not validate input or walk opaque application data. Invalid
 * values, including nulls forbidden on main, remain for the validator to reject.
 * `notice` defaults to one warning per converted null; the boundary passes its
 * once-per-field-per-run notice instead.
 * @internal
 */
export function normalizeLegacyRunAgentInput(
  input: unknown,
  notice: NullNotice = noticeEveryNull,
): unknown {
  let normalized = omitOptionalNulls(input, OPTIONAL_NULLS.RunAgentInput, "RunAgentInput", notice);
  normalized = mapProtocolArray(normalized, "tools", (tool) =>
    omitOptionalNulls(tool, OPTIONAL_NULLS.Tool, "Tool", notice),
  );
  normalized = mapProtocolArray(normalized, "resume", (entry) =>
    omitOptionalNulls(entry, OPTIONAL_NULLS.ResumeEntry, "ResumeEntry", notice),
  );
  return mapProtocolArray(normalized, "messages", (message) =>
    normalizeLegacyMessageNulls(message, notice),
  );
}

/**
 * The always-on pre-1.0 compatibility boundary.
 *
 * With enforcement running AFTER middleware (PNI-205), anything nobody
 * translates is stripped with a warning. This middleware is the translator:
 * it upgrades every retired-but-understood inbound shape into its 1.0
 * equivalent, so no data an old peer sends is lost. It is deliberately NOT
 * version-gated — a legacy-shaped event arriving is itself the proof the
 * peer is old, and on a modern stream every branch below is a no-op.
 * Outgoing legacy binary attachments are also upgraded before the transport
 * validates or sends them. Their shape identifies the conversion regardless
 * of the peer ceiling; actual downgrades remain version-gated separately.
 *
 * Inbound conversions, each warned with a pointer to the repo-root
 * DEPRECATIONS.md:
 * - THINKING_* events -> their REASONING_* equivalents. The version-gated
 *   BackwardCompatibility_0_0_45 runs the same state machine and keeps its
 *   0.0.45 threshold, but it is not untouched: its synthesized
 *   REASONING_MESSAGE_START now says `role: "reasoning"` where it used to say
 *   "assistant", the same correction made here, because enforcement moved
 *   behind the middleware chain and made the invalid role fatal. In practice
 *   only this translation runs: THIS middleware is appended innermost, so it
 *   sees every thinking event first and the shim always finds nothing to do
 *   (see the corpus README's "A shim with no fixture").
 * - Legacy binary content parts inside inbound messages (MESSAGES_SNAPSHOT,
 *   RUN_STARTED input) -> the modern media parts.
 * - The whole optional nulls listed in OPTIONAL_NULLS -> absent, on the event
 *   itself, in RUN_FINISHED's outcome and usage entries, and inside
 *   RUN_STARTED.input and inbound messages. Required and nested data nulls
 *   survive.
 *
 * The THINKING_* and binary conversions warn once per occurrence. An optional
 * null warns once per field and location per run: a producer that writes one
 * writes it on every event, and a warning per event would bury the stream.
 */
export class CompatibilityBoundary extends Middleware {
  private currentReasoningId: string | null = null;
  private currentMessageId: string | null = null;
  private nullsNoticedThisRun = new Set<string>();

  private readonly noticeNullOncePerRun: NullNotice = (what) => {
    if (this.nullsNoticedThisRun.has(what)) return;
    this.nullsNoticedThisRun.add(what);
    warnCompatibility(what, "an absent field");
  };

  private warn(what: string, replacement: string) {
    warnCompatibility(what, replacement);
  }

  /**
   * A THINKING_* continuation names nothing: the id it belongs to lives in
   * this middleware's state, put there by the matching opener. When no opener
   * preceded it, there is no id to reuse and one is MINTED — which turns a
   * producer's "content with no start" into a REASONING_* event naming an id
   * nothing ever opened. Verification rejects that a few stages later, with a
   * message about an id no producer ever wrote, so the mint is announced here:
   * without this line the rejection is untraceable to its cause.
   */
  private mintedContinuationId(from: string, established: string | null): string {
    if (established !== null) return established;
    const minted = randomUUID();
    this.warnAside(
      `Minting a messageId ('${minted}') for ${from}: no THINKING opener preceded it, so there was no id to continue. The id is this client's invention, not the producer's, and verification will reject the translated event for naming something nothing opened.`,
    );
    return minted;
  }

  /**
   * A conversion side effect the caller has to be told about in its own
   * sentence: something lost, or something invented. Separate from `warn`,
   * which only announces that a retired shape was translated — a reader who
   * saw only that would have no way to know the translation was not
   * information-preserving.
   */
  private warnAside(sentence: string) {
    if (
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      process.env.SUPPRESS_TRANSFORMATION_WARNINGS
    )
      return;
    console.warn(
      `[ag-ui][compat] ${sentence} Set SUPPRESS_TRANSFORMATION_WARNINGS=true to silence.`,
    );
  }

  override run(input: RunAgentInput, next: MiddlewareNext): Observable<BaseEvent> {
    this.currentReasoningId = null;
    this.currentMessageId = null;
    this.nullsNoticedThisRun.clear();
    // Deliberately next.run rather than runNext: runNext transforms chunks
    // before this middleware could see them, and the boundary must read the
    // RAW stream — a legacy null on a TOOL_CALL_CHUNK has to be converted
    // before chunk expansion discards or propagates it. The pipeline's own
    // chunk transformation still runs after the whole middleware chain.
    // Continuation handoffs can be bound to the lifecycle input's identity.
    // Replace its message list without mutating the original message content.
    input.messages = input.messages.map(upgradeMessageContent);
    return next.run(input).pipe(map((event) => this.transformEvent(event)));
  }

  private transformEvent(event: BaseEvent): BaseEvent {
    const notice = this.noticeNullOncePerRun;
    // A stream may carry several sequential runs; each one warns afresh.
    if (event.type === EventType.RUN_STARTED) this.nullsNoticedThisRun.clear();
    // Whole optional nulls first, so the translations below and combined old
    // shapes (e.g. result:null plus outcome:null) see the normalized event.
    event = omitOptionalNulls(event, OPTIONAL_NULLS.event, undefined, notice);
    const typeFields = EVENT_TYPE_OPTIONAL_NULLS.get(event.type);
    if (typeFields) event = omitOptionalNulls(event, typeFields, event.type, notice);
    switch (event.type as string) {
      case THINKING_START: {
        this.currentReasoningId = randomUUID();
        const { title, ...rest } = event as BaseEvent & { title?: string };
        this.warn(THINKING_START, EventType.REASONING_START);
        // REASONING_START has no `title`, so the span's label is dropped here
        // and nothing downstream can recover it. Named separately from the
        // conversion notice above because it is a LOSS, not a translation, and
        // the versioning rules require a lossy downgrade to say what went.
        if (title !== undefined) {
          this.warnAside(
            `Dropping ${THINKING_START}.title ${JSON.stringify(title)}: ${EventType.REASONING_START} has no title field, so the span's label cannot be carried and nothing downstream can recover it.`,
          );
        }
        return {
          ...rest,
          type: EventType.REASONING_START,
          messageId: this.currentReasoningId,
        };
      }

      case THINKING_TEXT_MESSAGE_START: {
        this.currentMessageId = randomUUID();
        this.warn(THINKING_TEXT_MESSAGE_START, EventType.REASONING_MESSAGE_START);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_START,
          messageId: this.currentMessageId,
          // The schema pins this role to "reasoning"; the translation used to
          // say "assistant", which nothing validated until enforcement moved
          // behind the middleware chain and made the invalid output fatal.
          role: "reasoning" as const,
        };
      }

      case THINKING_TEXT_MESSAGE_CONTENT: {
        const { delta, ...rest } = event as BaseEvent & { delta: string };
        this.warn(THINKING_TEXT_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_CONTENT);
        return {
          ...rest,
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.mintedContinuationId(
            THINKING_TEXT_MESSAGE_CONTENT,
            this.currentMessageId,
          ),
          delta,
        };
      }

      case THINKING_TEXT_MESSAGE_END: {
        const messageId = this.mintedContinuationId(
          THINKING_TEXT_MESSAGE_END,
          this.currentMessageId,
        );
        this.currentMessageId = null;
        this.warn(THINKING_TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_END);
        return {
          ...event,
          type: EventType.REASONING_MESSAGE_END,
          messageId,
        };
      }

      case THINKING_END: {
        const reasoningId = this.mintedContinuationId(THINKING_END, this.currentReasoningId);
        this.currentReasoningId = null;
        this.warn(THINKING_END, EventType.REASONING_END);
        return {
          ...event,
          type: EventType.REASONING_END,
          messageId: reasoningId,
        };
      }

      case EventType.RUN_FINISHED: {
        const record = event as BaseEvent & { outcome?: unknown };
        const outcome = omitOptionalNulls(
          record.outcome,
          OPTIONAL_NULLS["RUN_FINISHED.outcome"],
          "RUN_FINISHED.outcome",
          notice,
        );
        const normalized = outcome === record.outcome ? record : { ...record, outcome };
        return mapProtocolArray(normalized, "usage", (entry) =>
          omitOptionalNulls(
            entry,
            OPTIONAL_NULLS["RUN_FINISHED.usage[]"],
            "RUN_FINISHED.usage[]",
            notice,
          ),
        ) as BaseEvent;
      }

      case EventType.MESSAGES_SNAPSHOT: {
        const record = event as BaseEvent & { messages?: Message[] };
        if (!Array.isArray(record.messages)) return event;
        return {
          ...record,
          messages: record.messages.map((message) => this.upgradeInboundMessage(message)),
        };
      }

      case EventType.RUN_STARTED: {
        const normalizedInput = normalizeLegacyRunAgentInput(event.input, notice);
        const normalized =
          normalizedInput === event.input ? event : { ...event, input: normalizedInput };
        const record = normalized as BaseEvent & { input?: { messages?: Message[] } };
        if (!record.input || !Array.isArray(record.input.messages)) return normalized;
        return {
          ...record,
          input: {
            ...record.input,
            messages: record.input.messages.map((message) => this.upgradeInboundMessage(message)),
          },
        };
      }

      default:
        return event;
    }
  }

  private upgradeInboundMessage(message: Message): Message {
    // This helper changes only media-part metadata and preserves the rest of
    // the message shape; validation still happens after the boundary.
    message = normalizeLegacyMessageNulls(message, this.noticeNullOncePerRun) as Message;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    const hasLegacyBinary = content.some(
      (part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "binary",
    );
    if (!hasLegacyBinary) return message;
    this.warn("binary input content", "the modern media content parts");
    return upgradeMessageContent(message as never) as Message;
  }
}

/**
 * The boundary as a plain stream operator, for pipelines that have no
 * middleware chain to install it into (the connect/subscribe flow). A fresh
 * instance per subscription keeps the translation state per stream.
 */
export const compatibilityBoundaryOperator =
  () =>
  (source$: Observable<BaseEvent>): Observable<BaseEvent> =>
    defer(() => {
      const boundary = new CompatibilityBoundary();
      return source$.pipe(map((event) => boundary["transformEvent"](event)));
    });
