import {
  BaseEvent,
  EventType,
  type Metadata,
  mergeMetadata,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
} from "@ag-ui/core";
import jsonpatch from "fast-json-patch";
import { structuredClone_ } from "../utils";

/**
 * Folds the metadata of a run of events being replaced by one synthesized
 * event, so compacting a stream does not change the metadata a consumer ends up
 * with. Same last-write-wins, replace-wholesale rule the reducer applies, which
 * is what makes a compacted replay agree with the original stream.
 *
 * Ordering note. Compaction moves events to keep each stream's events together,
 * at the position of the stream's first event: an event that arrived mid-stream
 * comes out after the stream. Streams keep the order they opened in, so a replay
 * creates the messages in the same order. A MESSAGES_SNAPSHOT is a barrier: it
 * restates every message, so what each open stream delivered before it is
 * emitted ahead of it and the rest after it, and no delta is combined across it.
 *
 * What metadata does not add is any *new* order sensitivity. Every merge
 * destination is unique — each message has its own, and each tool call carries
 * its own rather than folding into the parent it may share — so two events that
 * merge into the same target are never reordered relative to each other.
 * Ordering within a buffer is preserved as well; see `postStartMetadata`, which
 * keeps deltas and replayed starts in arrival order.
 */
function carryStartMetadata<T extends BaseEvent>(previous: T | undefined, next: T): T {
  if (previous === undefined) {
    return next;
  }

  // A start event can be replayed before its end — the HITL re-sync path does
  // this, which is why the reducer's start handling is idempotent. Uncompacted,
  // both starts merge into the message; keep that true after compaction instead
  // of letting the later start silently replace the earlier one's keys.
  const metadata = mergeMetadata(previous.metadata, next.metadata);
  return metadata === undefined ? next : { ...next, metadata };
}

/**
 * Applies a start replayed *after* deltas have been buffered.
 *
 * Its non-metadata fields win — the reducer deliberately renames an existing
 * tool call on such a replay, so dropping them would make a compacted replay
 * disagree. Its metadata does not ride the start, because compaction emits the
 * start ahead of the collapsed delta event; the caller stages that separately so
 * arrival order is preserved.
 */
function replaceStartFields<T extends BaseEvent>(previous: T | undefined, next: T): T {
  const { metadata: _replayMetadata, ...fields } = next as T & { metadata?: Metadata };
  const carried = previous?.metadata;
  return (carried === undefined ? fields : { ...fields, metadata: carried }) as T;
}

function collapseMetadata(events: BaseEvent[]): Metadata | undefined {
  let merged: Metadata | undefined;
  for (const event of events) {
    merged = mergeMetadata(merged, event.metadata);
  }
  return merged;
}

/**
 * Compacts streaming events by consolidating multiple deltas into single events.
 * For text messages: multiple content deltas become one concatenated delta.
 * For reasoning messages: multiple content deltas become one concatenated delta.
 * For tool calls: multiple args deltas become one concatenated delta.
 * For state: all STATE_SNAPSHOT and STATE_DELTA events within a run are compacted
 *   into a single STATE_SNAPSHOT representing the final state.
 * Each stream's events are kept together where the stream started, so streams
 * stay in the order they opened in and other events keep their arrival order.
 * Deltas are not combined across a MESSAGES_SNAPSHOT (see the ordering note on
 * `carryStartMetadata`).
 *
 * @param events - Array of events to compact
 * @returns Compacted array of events
 */
export function compactEvents(events: BaseEvent[]): BaseEvent[] {
  // The output in arrival order. A stream reserves a slot where its first event
  // arrived and fills it when it ends, so it keeps its place among the other
  // streams and events: everything that arrived after its first event, even
  // mid-stream, comes out after it.
  const output: Array<BaseEvent | BaseEvent[]> = [];
  const reserveSlot = (): BaseEvent[] => {
    const slot: BaseEvent[] = [];
    output.push(slot);
    return slot;
  };

  const pendingTextMessages = new Map<
    string,
    {
      slot?: BaseEvent[];
      start?: TextMessageStartEvent;
      contents: TextMessageContentEvent[];
      end?: TextMessageEndEvent;
      postStartMetadata?: Metadata;
    }
  >();
  const pendingReasoningMessages = new Map<
    string,
    {
      slot?: BaseEvent[];
      start?: ReasoningMessageStartEvent;
      contents: ReasoningMessageContentEvent[];
      end?: ReasoningMessageEndEvent;
      postStartMetadata?: Metadata;
    }
  >();
  const pendingToolCalls = new Map<
    string,
    {
      slot?: BaseEvent[];
      start?: ToolCallStartEvent;
      args: ToolCallArgsEvent[];
      end?: ToolCallEndEvent;
      postStartMetadata?: Metadata;
    }
  >();

  // The buffer for a stream's events. A stream split by a messages snapshot has
  // no slot until its next event, which reserves one after the snapshot.
  const pendingFor = <P extends { slot?: BaseEvent[] }>(
    pendingById: Map<string, P>,
    id: string,
    create: () => P,
  ): P => {
    let pending = pendingById.get(id);
    if (!pending) {
      pending = create();
      pendingById.set(id, pending);
    }
    if (!pending.slot) {
      pending.slot = reserveSlot();
    }
    return pending;
  };

  // A stream that never ended is still emitted, in its slot.
  const flushPendingStreams = () => {
    for (const [id, pending] of pendingTextMessages) {
      if (pending.slot) flushTextMessage(id, pending, pending.slot);
    }
    for (const [id, pending] of pendingReasoningMessages) {
      if (pending.slot) flushReasoningMessage(id, pending, pending.slot);
    }
    for (const [id, pending] of pendingToolCalls) {
      if (pending.slot) flushToolCall(id, pending, pending.slot);
    }
    pendingTextMessages.clear();
    pendingReasoningMessages.clear();
    pendingToolCalls.clear();
  };

  // A MESSAGES_SNAPSHOT restates every message, including what the open streams
  // have delivered so far, and the deltas after it still apply. Emit what each
  // open stream has buffered ahead of the snapshot and collect the rest after
  // it, so no delta is combined across it.
  const splitPendingStreams = () => {
    const split = (pending: {
      slot?: BaseEvent[];
      start?: BaseEvent;
      postStartMetadata?: Metadata;
    }) => {
      pending.slot = undefined;
      pending.start = undefined;
      pending.postStartMetadata = undefined;
    };
    for (const [id, pending] of pendingTextMessages) {
      if (!pending.slot) continue;
      flushTextMessage(id, pending, pending.slot);
      split(pending);
      pending.contents = [];
    }
    for (const [id, pending] of pendingReasoningMessages) {
      if (!pending.slot) continue;
      flushReasoningMessage(id, pending, pending.slot);
      split(pending);
      pending.contents = [];
    }
    for (const [id, pending] of pendingToolCalls) {
      if (!pending.slot) continue;
      flushToolCall(id, pending, pending.slot);
      split(pending);
      pending.args = [];
    }
  };

  // State compaction: collects state events, flushed at RUN_STARTED (pre-run/inter-run), RUN_FINISHED/RUN_ERROR (in-run), and at end (trailing)
  let stateEvents: (StateSnapshotEvent | StateDeltaEvent)[] = [];

  for (const event of events) {
    // Handle text message streaming events
    if (event.type === EventType.TEXT_MESSAGE_START) {
      const startEvent = event as TextMessageStartEvent;
      const pending = pendingFor(pendingTextMessages, startEvent.messageId, () => ({
        contents: [],
      }));
      if (pending.contents.length === 0) {
        pending.start = carryStartMetadata(pending.start, startEvent);
      } else {
        // Compaction hoists START ahead of the collapsed delta event, so a start
        // replayed after deltas keeps its fields but stages its metadata.
        pending.start = replaceStartFields(pending.start, startEvent);
        pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, startEvent.metadata);
      }
    } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const contentEvent = event as TextMessageContentEvent;
      const pending = pendingFor(pendingTextMessages, contentEvent.messageId, () => ({
        contents: [],
      }));
      pending.contents.push(contentEvent);
      pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, contentEvent.metadata);
    } else if (event.type === EventType.TEXT_MESSAGE_END) {
      const endEvent = event as TextMessageEndEvent;
      const messageId = endEvent.messageId;
      const pending = pendingFor(pendingTextMessages, messageId, () => ({ contents: [] }));
      pending.end = endEvent;

      // Flush this message's events into its slot
      flushTextMessage(messageId, pending, pending.slot!);
      pendingTextMessages.delete(messageId);
    } else if (event.type === EventType.REASONING_MESSAGE_START) {
      // Reasoning messages compact exactly like text messages: the reducer
      // appends each content delta to the message, so one concatenated delta
      // yields the same message.
      const startEvent = event as ReasoningMessageStartEvent;
      const pending = pendingFor(pendingReasoningMessages, startEvent.messageId, () => ({
        contents: [],
      }));
      if (pending.contents.length === 0) {
        pending.start = carryStartMetadata(pending.start, startEvent);
      } else {
        // Same ordering rule as the text case above.
        pending.start = replaceStartFields(pending.start, startEvent);
        pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, startEvent.metadata);
      }
    } else if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
      const contentEvent = event as ReasoningMessageContentEvent;
      const pending = pendingFor(pendingReasoningMessages, contentEvent.messageId, () => ({
        contents: [],
      }));
      pending.contents.push(contentEvent);
      pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, contentEvent.metadata);
    } else if (event.type === EventType.REASONING_MESSAGE_END) {
      const endEvent = event as ReasoningMessageEndEvent;
      const messageId = endEvent.messageId;
      const pending = pendingFor(pendingReasoningMessages, messageId, () => ({ contents: [] }));
      pending.end = endEvent;

      flushReasoningMessage(messageId, pending, pending.slot!);
      pendingReasoningMessages.delete(messageId);
    } else if (event.type === EventType.TOOL_CALL_START) {
      const startEvent = event as ToolCallStartEvent;
      const pending = pendingFor(pendingToolCalls, startEvent.toolCallId, () => ({ args: [] }));
      if (pending.args.length === 0) {
        pending.start = carryStartMetadata(pending.start, startEvent);
      } else {
        // Same ordering rule as the text case above.
        pending.start = replaceStartFields(pending.start, startEvent);
        pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, startEvent.metadata);
      }
    } else if (event.type === EventType.TOOL_CALL_ARGS) {
      const argsEvent = event as ToolCallArgsEvent;
      const pending = pendingFor(pendingToolCalls, argsEvent.toolCallId, () => ({ args: [] }));
      pending.args.push(argsEvent);
      pending.postStartMetadata = mergeMetadata(pending.postStartMetadata, argsEvent.metadata);
    } else if (event.type === EventType.TOOL_CALL_END) {
      const endEvent = event as ToolCallEndEvent;
      const toolCallId = endEvent.toolCallId;
      const pending = pendingFor(pendingToolCalls, toolCallId, () => ({ args: [] }));
      pending.end = endEvent;

      // Flush this tool call's events into its slot
      flushToolCall(toolCallId, pending, pending.slot!);
      pendingToolCalls.delete(toolCallId);
    } else if (event.type === EventType.RUN_STARTED) {
      // Flush any pre-run state events before starting a new run
      flushState(stateEvents, reserveSlot());
      stateEvents = [];
      output.push(event);
    } else if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      // An incomplete text/tool stream is still part of the run that is ending.
      // Flush it before the terminal event; emitting it afterwards creates an
      // ordering that verifyEvents() rejects on replay.
      flushPendingStreams();

      // Flush compacted state into output before the run boundary event
      flushState(stateEvents, reserveSlot());
      stateEvents = [];
      output.push(event);
    } else if (event.type === EventType.STATE_SNAPSHOT || event.type === EventType.STATE_DELTA) {
      // Collect state events for compaction
      stateEvents.push(event as StateSnapshotEvent | StateDeltaEvent);
    } else if (event.type === EventType.MESSAGES_SNAPSHOT) {
      splitPendingStreams();
      output.push(event);
    } else {
      // Any other event stays where it arrived: after the streams that opened
      // before it, which their slots keep together.
      output.push(event);
    }
  }

  // Streams that never ended, when stored history stops without a run terminal.
  flushPendingStreams();

  // Flush any remaining state events (incomplete run or events outside runs)
  flushState(stateEvents, reserveSlot());

  const compacted: BaseEvent[] = [];
  for (const entry of output) {
    if (Array.isArray(entry)) {
      compacted.push(...entry);
    } else {
      compacted.push(entry);
    }
  }
  return compacted;
}

function flushTextMessage(
  messageId: string,
  pending: {
    start?: TextMessageStartEvent;
    contents: TextMessageContentEvent[];
    end?: TextMessageEndEvent;
    postStartMetadata?: Metadata;
  },
  compacted: BaseEvent[],
): void {
  // Add start event if present
  if (pending.start) {
    compacted.push(pending.start);
  }

  // Compact all content events into one
  if (pending.contents.length > 0) {
    const concatenatedDelta = pending.contents.map((c) => c.delta).join("");

    const collapsedMetadata = pending.postStartMetadata;

    const compactedContent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: messageId,
      delta: concatenatedDelta,
      ...(collapsedMetadata !== undefined && { metadata: collapsedMetadata }),
    };

    compacted.push(compactedContent);
  }

  // Add end event if present
  if (pending.end) {
    compacted.push(pending.end);
  }
}

function flushReasoningMessage(
  messageId: string,
  pending: {
    start?: ReasoningMessageStartEvent;
    contents: ReasoningMessageContentEvent[];
    end?: ReasoningMessageEndEvent;
    postStartMetadata?: Metadata;
  },
  compacted: BaseEvent[],
): void {
  if (pending.start) {
    compacted.push(pending.start);
  }

  if (pending.contents.length > 0) {
    const concatenatedDelta = pending.contents.map((c) => c.delta).join("");

    const collapsedMetadata = pending.postStartMetadata;

    const compactedContent: ReasoningMessageContentEvent = {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: messageId,
      delta: concatenatedDelta,
      ...(collapsedMetadata !== undefined && { metadata: collapsedMetadata }),
    };

    compacted.push(compactedContent);
  }

  if (pending.end) {
    compacted.push(pending.end);
  }
}

function flushToolCall(
  toolCallId: string,
  pending: {
    start?: ToolCallStartEvent;
    args: ToolCallArgsEvent[];
    end?: ToolCallEndEvent;
    postStartMetadata?: Metadata;
  },
  compacted: BaseEvent[],
): void {
  // Add start event if present
  if (pending.start) {
    compacted.push(pending.start);
  }

  // Compact all args events into one
  if (pending.args.length > 0) {
    const concatenatedArgs = pending.args.map((a) => a.delta).join("");

    const collapsedMetadata = pending.postStartMetadata;

    const compactedArgs: ToolCallArgsEvent = {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: toolCallId,
      delta: concatenatedArgs,
      ...(collapsedMetadata !== undefined && { metadata: collapsedMetadata }),
    };

    compacted.push(compactedArgs);
  }

  // Add end event if present
  if (pending.end) {
    compacted.push(pending.end);
  }
}

/**
 * Compaction's warnings, behind the same switch as the rest of the package.
 * `SUPPRESS_TRANSFORMATION_WARNINGS` is the one control an operator has over
 * transformation chatter (enforce.ts, transform/proto.ts and the compatibility
 * middlewares all honour it); a warning that ignored it was unsilenceable.
 */
const warnCompact = (message: string): void => {
  if (
    typeof process !== "undefined" &&
    typeof process.env !== "undefined" &&
    Boolean(process.env.SUPPRESS_TRANSFORMATION_WARNINGS)
  ) {
    return;
  }
  console.warn(message);
};

function flushState(
  stateEvents: (StateSnapshotEvent | StateDeltaEvent)[],
  compacted: BaseEvent[],
): void {
  if (stateEvents.length === 0) {
    return;
  }

  // A window with no SNAPSHOT in it cannot be collapsed into one. Collapsing
  // `SNAPSHOT + deltas` is sound because the snapshot states the whole
  // document and the deltas refine it. Deltas ALONE are relative to a state
  // this window never saw, so seeding `{}` and calling the result a snapshot
  // manufactures an authoritative claim that everything else was absent —
  // replaying it wipes state the consumer legitimately holds from before the
  // window. Passed through unchanged instead: two deltas are barely worth
  // collapsing anyway, and correctness is not negotiable for the saving.
  // The LAST snapshot, not merely "is there one": everything before it is
  // unobservable by definition, because a snapshot restates the whole document
  // and replaces whatever the deltas ahead of it had built. Folding those
  // deltas anyway applied them to the seeded `{}`, where their paths do not
  // resolve — `applyPatch` validates, so it threw, and the catch below warned
  // about a patch whose failure changed nothing. Right answer, wrong
  // diagnosis. Starting at the last snapshot means the catch only ever fires
  // for a patch that genuinely could not be applied to the state it names.
  //
  // A reverse loop rather than `findLastIndex`: this package targets es2017,
  // and the method is ES2023.
  let lastSnapshot = -1;
  for (let index = stateEvents.length - 1; index >= 0; index--) {
    if (stateEvents[index].type === EventType.STATE_SNAPSHOT) {
      lastSnapshot = index;
      break;
    }
  }
  if (lastSnapshot === -1) {
    compacted.push(...stateEvents);
    return;
  }

  // From here the window DOES contain a snapshot, so it collapses exactly as
  // it always has: seeding `{}` is harmless because the snapshot replaces the
  // document wholesale before anything relative is applied to it.
  let state: Record<string, unknown> = {};

  for (const event of stateEvents.slice(lastSnapshot)) {
    if (event.type === EventType.STATE_SNAPSHOT) {
      state = structuredClone_(event.snapshot);
    } else {
      // Uncaught, a single unappliable patch took down every consumer that
      // compacts a stream — `applyPatch` validates, so it THROWS rather than
      // answering falsy. Warned and skipped, matching the reducer in
      // apply/default.ts, which faces exactly the same failure.
      try {
        state = jsonpatch.applyPatch(state, structuredClone_(event.delta), true, false)
          .newDocument;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        warnCompact(
          `[ag-ui][compact] Failed to apply state patch while compacting:\nCurrent state: ${JSON.stringify(state, null, 2)}\nPatch operations: ${JSON.stringify(event.delta, null, 2)}\nError: ${errorMessage}`,
        );
      }
    }
  }

  const collapsedMetadata = collapseMetadata(stateEvents);

  const compactedSnapshot: StateSnapshotEvent = {
    type: EventType.STATE_SNAPSHOT,
    snapshot: state,
    ...(collapsedMetadata !== undefined && { metadata: collapsedMetadata }),
  };

  compacted.push(compactedSnapshot);
}
