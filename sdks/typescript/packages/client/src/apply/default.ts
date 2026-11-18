import { authoritativeActivityTypes } from "../activity-history";
import type { AbstractAgent } from "@/agent/agent";
import {
  type AgentStateMutation,
  type AgentSubscriber,
  runSubscribersWithMutation,
} from "@/agent/subscriber";
import {
  type ActivityDeltaEvent,
  type ActivityMessage,
  type ActivitySnapshotEvent,
  type AssistantMessage,
  type BaseEvent,
  type CustomEvent,
  EventType,
  type Message,
  type MessagesSnapshotEvent,
  type Metadata,
  mergeMetadata,
  type RawEvent,
  type ReasoningEncryptedValueEvent,
  type ReasoningEndEvent,
  type ReasoningMessage,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type ReasoningStartEvent,
  type RunAgentInput,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type StateDeltaEvent,
  type StateSnapshotEvent,
  type StepFinishedEvent,
  type StepStartedEvent,
  type SubagentErrorEvent,
  type SubagentFinishedEvent,
  type SubagentStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCall,
  type ToolCallStartEvent,
  type ToolMessage,
} from "@ag-ui/core";
import jsonpatch from "fast-json-patch";
import { EMPTY, of } from "rxjs";
import type { Observable } from "rxjs";
import { defaultIfEmpty } from "rxjs/operators";
import untruncateJson from "untruncate-json";
import { structuredClone_ } from "../utils";
import { applyInOrder, type Backlog } from "./apply-in-order";
import { MessageLookup } from "./message-lookup";
import { type DebugLoggerInput, resolveDebugLogger } from "@/debug-logger";

/**
 * Resolves (or creates) the assistant message that a tool call should attach to.
 *
 * Resolution order:
 * 1. `parentMessageId` matches an existing assistant message — return it.
 * 2. `parentMessageId` matches a non-assistant message (collision) — create new, keyed by `toolCallId`.
 * 3. `parentMessageId` not found — create new, keyed by `parentMessageId`.
 * 4. No `parentMessageId` — create new, keyed by `toolCallId`.
 */
function resolveOrCreateAssistantMessage(
  messages: Message[],
  parentMessageId: string | undefined,
  toolCallId: string,
  lookup: MessageLookup,
): AssistantMessage {
  if (parentMessageId) {
    const existing = lookup.find(messages, parentMessageId);
    if (existing?.role === "assistant") {
      return existing as AssistantMessage;
    }

    if (existing) {
      console.warn(
        `TOOL_CALL_START: parentMessageId '${parentMessageId}' matches a '${existing.role}' message, ` +
          `not assistant — falling back to toolCallId`,
      );
    }

    const created: AssistantMessage = {
      id: existing ? toolCallId : parentMessageId,
      role: "assistant",
      toolCalls: [],
    };
    messages.push(created);
    return created;
  }

  const created: AssistantMessage = { id: toolCallId, role: "assistant", toolCalls: [] };
  messages.push(created);
  return created;
}

/**
 * Folds an event's metadata into the thing that event builds, key by key, with
 * the last write winning.
 *
 * The target is a message, or a tool call for the TOOL_CALL_* events — a tool
 * call is not a message, and several can share one parent assistant message, so
 * folding theirs into that parent would make the result depend on their relative
 * order. Metadata on a run-, step- or state-level event belongs to that event
 * and never reaches either.
 *
 * Values are cloned so the event payload can't alias into the message array and
 * be mutated later through the caller's copy of the event.
 *
 * Returns whether anything changed, so callers only emit a mutation when it did.
 *
 * Known limitation, deliberately not fixed here. Handlers resolve their target
 * before running subscribers, so a subscriber that returns a replacement
 * `messages` array leaves that reference pointing into the discarded one and
 * this write is lost. Review has raised it repeatedly; it is not fixed because
 * the cure is worse than the disease. Re-resolving by id costs an O(n) scan on
 * TEXT_MESSAGE_CONTENT, which fires per streamed token, to fix a case that needs
 * a subscriber replacing the array from that specific hook — and the same
 * staleness already loses the content append on `main`, so it is a pre-existing
 * reducer issue rather than a metadata one. Fixing it belongs in its own change,
 * conditional on `mutation.messages !== undefined` so the hot path pays nothing.
 */
function applyEventMetadata(
  target: { metadata?: Metadata } | undefined,
  event: BaseEvent,
): boolean {
  if (!target || event.metadata === undefined) {
    return false;
  }
  target.metadata = mergeMetadata(target.metadata, structuredClone_(event.metadata));
  return true;
}

// The role of a history entry, or undefined for a null or non-object entry.
const roleOf = (message: unknown): unknown =>
  typeof message === "object" && message !== null
    ? (message as { role?: unknown }).role
    : undefined;

// The call ids an assistant message issues. Ignores a non-array `toolCalls`
// and entries that are not objects with a string `id`, which unverified input
// can carry.
function issuedCallIds(message: unknown): string[] {
  if (roleOf(message) !== "assistant") return [];
  const toolCalls = (message as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) return [];
  const ids: string[] = [];
  for (const toolCall of toolCalls) {
    if (typeof toolCall !== "object" || toolCall === null) continue;
    const id = (toolCall as { id?: unknown }).id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * Move each tool result that has drifted away from its call to sit right
 * after the assistant message that issued it — usually back to an earlier
 * call, and forward only when exactly one call in the whole history has its
 * id. Runs when a MESSAGES_SNAPSHOT is applied, and on the copy of the
 * history `prepareRunAgentInput` sends as a run's input.
 *
 * Providers require an assistant tool_call to be immediately followed by its
 * result, and this history is sent back as the next run's input. The
 * MESSAGES_SNAPSHOT merge matches by id, and ids are generally not stable
 * between streamed events and the snapshot: a streamed result the snapshot
 * re-ids is dropped from its place and the snapshot's copy is appended, leaving
 * `assistant(tool_call) -> assistant(text) -> tool`. A history already stored
 * in that order is never reordered by the merge either; this pass repairs it
 * the next time a MESSAGES_SNAPSHOT arrives, and not before.
 *
 * Semantics, by list position (index) only — never object identity or message
 * id. The merge can put one message object in the list twice (two local
 * messages sharing an id map to the same snapshot object); those are two
 * independent slots. Nothing is dropped, deduplicated or added, and only
 * tool-role messages change position. So a call message the merge duplicated
 * is two calls, and the copy its result does not pair with stays unanswered.
 *
 * - Null and non-object entries are transparent: they are passed through in
 *   place and otherwise ignored, so they never separate a call from its result.
 *   This tolerance is for direct callers: the MESSAGES_SNAPSHOT merge reads a
 *   field of every entry before calling this, and `prepareRunAgentInput`
 *   reads one before a run, so a null entry fails there first.
 * - The anchor of a position is the last entry before it that is an object
 *   whose role is not `tool`, `activity` or `reasoning`. `activity` never goes
 *   to the backend — `prepareRunAgentInput` strips it from RunAgentInput — so
 *   it does not separate a result from its call. Neither does `reasoning`:
 *   reasoning stored between a call and its result is the next step's. A
 *   multi-step Mastra turn whose calls share one assistant message leaves
 *   `assistant(c1, c2), tool(c1), reasoning, tool(c2)`, and moving the result
 *   in front of the reasoning leaves it trailing, so Mastra drops it.
 *   Anything else separates them.
 * - At an assistant message whose `toolCalls` is an array, each entry that is
 *   a non-null object with a string `id` opens a call slot for that id,
 *   recording the message's index as its issuer. Other entries and a
 *   non-array `toolCalls` are ignored.
 * - Slots are matched by call id alone. `subagentRunId` is ignored: on a
 *   result it names the run that executed the tool, which may differ from
 *   the run that issued the call. Known limitation: a parent call and a
 *   subagent call that reuse one id are indistinguishable, so their drifted
 *   results can be swapped between them.
 * - First pass, left to right: a tool message with a string `toolCallId` that
 *   finds an unanswered slot for its id issued at its anchor is in place. It
 *   answers that slot and stays. Otherwise, if an earlier slot for the id is
 *   unanswered, the result is detached; detached results do not answer slots
 *   in this pass. A result with no earlier slot for its id at all is early.
 *   Any other result — every earlier slot for its id already answered — stays
 *   where it is, as does a result without a string id.
 * - Backward, per id: the detached results, from the last back to the first,
 *   each answer the newest still-unanswered slot issued before it and move to
 *   that slot's issuer. One that finds none stays.
 *
 *   Newest-back keeps each turn's result with its turn when several detached
 *   results share an id that providers reuse every turn (`call_0`): after a
 *   reload re-ids every result, `u1 a1 a1t u2 a2 a2t t1 t2` becomes
 *   `u1 a1 t1 a1t u2 a2 t2 a2t`. It also means a lone detached result goes to
 *   the nearest open call, so a result is not pulled back past a later call
 *   with its id to an earlier one that was abandoned. It cannot tell a
 *   duplicate result from a late answer, though: a second result for a call
 *   that is already answered moves back to an older unanswered call with the
 *   same id, across any user turns in between.
 * - Forward, only for a unique id: an early result moves forward only when
 *   its id is on exactly one call slot in the whole list (counting every
 *   entry of every assistant `toolCalls`, aliased copies included), and that
 *   slot is still unanswered after the first pass and the backward pass. Then
 *   the first early result for the id, left to right, answers it and moves
 *   to its issuer; any other early results for the id stay. This repairs a
 *   result whose call was re-issued after it — typically the snapshot re-ids
 *   the assistant message but keeps the result's id, and the merge leaves
 *   `t a(tool_call)`. When the id is reused (providers issue `call_0` every
 *   turn), the call an early result belongs to is a guess: it may be a
 *   later turn's human-in-the-loop call still waiting on the user, and
 *   answering it with an old result would be wrong. So with a reused id no
 *   result moves forward, and early results stay where they are.
 * - Output keeps the original order without the moved results. Each issuer's
 *   moved results, forward and backward alike, follow it in their original
 *   order, after the tool, activity, reasoning, null and non-object entries
 *   directly behind it and before the next entry that is none of those (or at
 *   the end) — but in front of any reasoning among the activity, reasoning,
 *   null and non-object entries at that point. Reasoning belongs to the
 *   message after it, so a moved result never lands between a reasoning
 *   message and its owner: `u a(c) r x t(c)` becomes `u a t r x`.
 *
 * Linear in the length of the list, apart from sorting the results that move
 * and one case: when a single assistant message repeats a call id k times,
 * each result for that id behind it scans those k slots.
 * Returns the same array when nothing moves.
 */
export function keepToolResultsWithCalls(messages: Message[]): Message[] {
  // Call slots per call id, as issuer indices in the order opened, and
  // whether each is answered.
  const slots = new Map<string, { issuer: number; answered: boolean }[]>();
  // How many of each id's slots are still unanswered.
  const unanswered = new Map<string, number>();
  const answer = (id: string, slot: { issuer: number; answered: boolean }) => {
    slot.answered = true;
    unanswered.set(id, unanswered.get(id)! - 1);
  };
  // Detached result indices per call id, in original order.
  const detached = new Map<string, number[]>();
  // Result indices per call id, in original order, that no earlier slot for
  // their id exists for: the only results that may move forward, and only
  // when their id ends up on exactly one slot.
  const early = new Map<string, number[]>();
  const append = <K, T>(map: Map<K, T[]>, key: K, value: T) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  let anchor = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const role = roleOf(message);
    if (role === "tool") {
      const id = (message as ToolMessage).toolCallId;
      if (typeof id !== "string") continue;
      const idSlots = slots.get(id);
      if (!idSlots) {
        append(early, id, index);
        continue;
      }
      // Slots open in list order and the anchor is the newest issuer, so the
      // anchor's slots sit at the tail: scan only those.
      let inPlace: { issuer: number; answered: boolean } | undefined;
      for (let s = idSlots.length - 1; s >= 0 && idSlots[s].issuer === anchor; s--) {
        if (!idSlots[s].answered) inPlace = idSlots[s];
      }
      if (inPlace) {
        answer(id, inPlace);
        continue;
      }
      // Every slot for this id issued at the anchor is answered, so a
      // detached result can only take a slot for its id issued before the
      // anchor, which no later in-place result can take. Deciding the
      // in-place results first is therefore safe.
      if (unanswered.get(id)! > 0) append(detached, id, index);
    } else if (role !== "activity" && role !== "reasoning") {
      anchor = index;
      for (const id of issuedCallIds(message)) {
        append(slots, id, { issuer: index, answered: false });
        unanswered.set(id, (unanswered.get(id) ?? 0) + 1);
      }
    }
  }

  // Moved result indices per issuer index.
  const owedTo = new Map<number, number[]>();
  const moved: boolean[] = [];
  const move = (id: string, index: number, slot: { issuer: number; answered: boolean }) => {
    answer(id, slot);
    append(owedTo, slot.issuer, index);
    moved[index] = true;
  };
  // Backward: each id's detached results, newest first, take the newest
  // unanswered slot for their id issued before them. Each result needs a slot
  // issued before it and they go newest first, so that slot only ever moves
  // left: one cursor per id keeps the pass linear even when every turn reuses
  // the same id.
  for (const [id, results] of detached) {
    const idSlots = slots.get(id)!;
    let s = idSlots.length - 1;
    for (let r = results.length - 1; r >= 0; r--) {
      const index = results[r];
      while (s >= 0 && (idSlots[s].answered || idSlots[s].issuer >= index)) s--;
      if (s < 0) break;
      move(id, index, idSlots[s]);
    }
  }
  // Forward: only when the id is on exactly one call slot in the whole list.
  // With a reused id, which later call an early result belongs to is a guess,
  // and a wrong guess answers a call that may still be pending (a
  // human-in-the-loop call_0 waiting on the user), so those results stay.
  // The unique slot is issued after every early result for its id (none had
  // an earlier slot), and if it is still open the first of them takes it.
  for (const [id, results] of early) {
    const idSlots = slots.get(id);
    if (idSlots?.length !== 1 || idSlots[0].answered) continue;
    move(id, results[0], idSlots[0]);
  }
  if (owedTo.size === 0) return messages;
  // Ids are matched one at a time, and forward and backward moves can share
  // an issuer; restore each issuer's results to their original order.
  for (const owed of owedTo.values()) owed.sort((a, b) => a - b);

  const repaired: Message[] = [];
  let owed: number[] | undefined;
  const flush = () => {
    if (owed) {
      // Converters give a reasoning message to the message after it, so the
      // owed results go in front of any reasoning among the entries at the
      // tail that do not separate, never between a reasoning message and its
      // owner. Activity is stripped before a run, so it is looked past too.
      let at = repaired.length;
      for (let tail = repaired.length - 1; tail >= 0; tail--) {
        const entry = repaired[tail];
        const role = roleOf(entry);
        if (
          typeof entry === "object" &&
          entry !== null &&
          role !== "activity" &&
          role !== "reasoning"
        )
          break;
        if (role === "reasoning") at = tail;
      }
      // Pushed one by one: spreading a large batch into splice() exceeds the
      // engine's argument limit (RangeError: Maximum call stack size exceeded).
      const tail = repaired.splice(at);
      for (const index of owed) repaired.push(messages[index]);
      for (const entry of tail) repaired.push(entry);
    }
    owed = undefined;
  };
  for (let index = 0; index < messages.length; index++) {
    if (moved[index]) continue;
    const message = messages[index];
    const role = roleOf(message);
    const separates =
      typeof message === "object" &&
      message !== null &&
      role !== "tool" &&
      role !== "activity" &&
      role !== "reasoning";
    if (separates) flush();
    repaired.push(message);
    // Only a separating entry can be an issuer, and it flushed the previous
    // issuer's results just above, so nothing owed is overwritten.
    owed = owedTo.get(index) ?? owed;
  }
  // Results owed to the last issuer, which no later separating entry flushed.
  flush();
  return repaired;
}

/**
 * A copy of a message for an emitted update. Copies every container the
 * reducer edits in place (the message, its `toolCalls` array, each tool call
 * and its `function`) and shares everything else. Strings are immutable, and
 * nested values such as metadata and multimodal content are only ever
 * replaced by the reducer, never edited.
 *
 * Activity content is copied whole. Consumers edit it: A2UI keeps the
 * operations it is handed as its data model and changes them on form input.
 * The next ACTIVITY_DELTA patches the reducer's content, so a shared object
 * would carry that edit into later updates.
 */
function copyForEmit(message: Message): Message {
  const copy = { ...message } as Message & { toolCalls?: ToolCall[] };
  if (message.role === "activity") {
    (copy as ActivityMessage).content = structuredClone_((message as ActivityMessage).content);
  }
  const toolCalls = (message as { toolCalls?: ToolCall[] }).toolCalls;
  if (Array.isArray(toolCalls)) {
    copy.toolCalls = toolCalls.map((toolCall) =>
      toolCall?.function ? { ...toolCall, function: { ...toolCall.function } } : { ...toolCall },
    );
  }
  return copy;
}

/**
 * Whether `working` still matches the copy emitted for it. A shallow check is
 * enough for the same reason a shallow copy is: the reducer changes a message
 * only by assigning fields (a new string, a new metadata object), adding or
 * deleting keys, or editing its tool calls, and each of those shows up here.
 * `sourceContent` is the working content the copy was made from, which stands
 * in for the copy's own `content` when that was copied whole (activity).
 */
function isUnchangedSince(copy: Message, working: Message, sourceContent: unknown): boolean {
  const copyKeys = Object.keys(copy);
  if (copyKeys.length !== Object.keys(working).length) return false;
  for (const key of copyKeys) {
    const copyValue = key === "content" ? sourceContent : (copy as Record<string, unknown>)[key];
    const workingValue = (working as Record<string, unknown>)[key];
    if (key === "toolCalls" && Array.isArray(copyValue) && Array.isArray(workingValue)) {
      if (!sameToolCalls(copyValue as ToolCall[], workingValue as ToolCall[])) return false;
    } else if (copyValue !== workingValue) {
      return false;
    }
  }
  return true;
}

function sameToolCalls(copy: ToolCall[], working: ToolCall[]): boolean {
  if (copy.length !== working.length) return false;
  for (let index = 0; index < copy.length; index += 1) {
    const copyCall = copy[index] as ToolCall & Record<string, unknown>;
    const workingCall = working[index] as ToolCall & Record<string, unknown>;
    const keys = Object.keys(copyCall);
    if (keys.length !== Object.keys(workingCall).length) return false;
    for (const key of keys) {
      if (key === "function" && copyCall.function && workingCall.function) {
        const copyFunction = copyCall.function as unknown as Record<string, unknown>;
        const workingFunction = workingCall.function as unknown as Record<string, unknown>;
        const functionKeys = Object.keys(copyFunction);
        if (functionKeys.length !== Object.keys(workingFunction).length) return false;
        for (const functionKey of functionKeys) {
          if (copyFunction[functionKey] !== workingFunction[functionKey]) return false;
        }
      } else if (copyCall[key] !== workingCall[key]) {
        return false;
      }
    }
  }
  return true;
}

/** Options for {@link defaultApplyEvents}. */
export interface ApplyEventsOptions {
  /**
   * Emit one update for events that arrive together, instead of one per event.
   * An update is emitted only when no further event is waiting to be applied,
   * so a burst (a thread history replayed at once, or several events parsed
   * from one network chunk) yields a single update with the state after its
   * last event. Per-event subscriber hooks still run for every event, with the
   * current messages and state; what is merged is the emitted updates, and
   * with them `agent.messages`, `agent.state`, `onMessagesChanged` and
   * `onStateChanged`. Events that arrive one at a time still emit one update
   * each. Off by default.
   */
  coalesce?: boolean;
}

/**
 * Applies a run's events to the agent's messages and state, and emits an
 * update after each event that changed them.
 *
 * What an emitted update shares, and with whom:
 * - Emitted messages are read-only, including every nested value (metadata,
 *   multimodal content, tool calls). An unchanged message is the same object
 *   in consecutive updates, and a changed message shares its unchanged nested
 *   values with the reducer's working copy. Editing one in place can change an
 *   earlier update that holds it, and what later updates contain.
 * - The reducer itself never changes an update it emitted. It copies every
 *   container it edits in place (each message, its `toolCalls` array, each
 *   tool call and its `function`), and it replaces nested values rather than
 *   editing them.
 * - Two values are copied whole because consumers are known to edit them:
 *   emitted `state`, which the agent assigns to `agent.state`, and activity
 *   message `content`, which A2UI keeps as its data model. Edits to either
 *   never reach later updates. An edited state or activity object can still
 *   change an earlier update that holds the same object.
 * - Incoming payloads (`MESSAGES_SNAPSHOT` messages, `STATE_SNAPSHOT` and
 *   `ACTIVITY_SNAPSHOT` content, `STATE_DELTA` and `ACTIVITY_DELTA` values,
 *   event metadata) are copied on intake, so a caller's event objects never
 *   alias emitted values.
 *
 * With `options.coalesce`, an update is emitted only once no further event is
 * waiting to be applied; see {@link ApplyEventsOptions}.
 */
export const defaultApplyEvents = (
  input: RunAgentInput,
  events$: Observable<BaseEvent>,
  agent: AbstractAgent,
  subscribers: AgentSubscriber[],
  debugLogger?: DebugLoggerInput,
  options?: ApplyEventsOptions,
): Observable<AgentStateMutation> => {
  const log = resolveDebugLogger(debugLogger);
  const coalesce = options?.coalesce === true;
  // Events received but not yet picked up for applying. With `coalesce`, an
  // update waits until none are.
  const backlog: Backlog = { waiting: 0 };
  let messages = structuredClone_(agent.messages);
  let state = structuredClone_(input.state);
  let currentMutation: AgentStateMutation = {};
  // Every lookup by message id or tool call id goes through this index rather
  // than scanning `messages`, so an event costs the same in a long thread as in
  // a short one.
  const lookup = new MessageLookup();

  // The tool calls this run has started and answered so far. RUN_FINISHED
  // reads them when the success outcome names no `pendingToolCallIds`: the
  // specification lets a consumer derive the pending list from the stream —
  // every call the run started that got no TOOL_CALL_RESULT — and a producer
  // that names the list is trusted over the tally.
  // Starts within an open stream are duplicates. A start after an end (or in
  // a new run) begins a new argument stream, including for a call in history.
  const activeToolCallIds = new Set<string>();
  const replaceToolCallArgs = new Set<string>();
  let runToolCallIds: string[] = [];
  let answeredToolCallIds = new Set<string>();
  const pendingToolCallIdsOf = (e: RunFinishedEvent): string[] => {
    const named = e.outcome?.type === "success" ? e.outcome.pendingToolCallIds : undefined;
    if (named !== undefined && named.length > 0) return [...named];
    return runToolCallIds.filter((id) => !answeredToolCallIds.has(id));
  };

  const applyMutation = (mutation: AgentStateMutation) => {
    if (mutation.messages !== undefined) {
      messages = mutation.messages;
      currentMutation.messages = mutation.messages;
    }
    if (mutation.state !== undefined) {
      state = mutation.state;
      currentMutation.state = mutation.state;
    }
  };

  // The reducer edits its working messages in place, but it must never change
  // an update it has emitted: subscribers, `agent.messages` and anything that
  // kept a snapshot hold it. See the contract above. Deep-cloning every message on every
  // emitted update kept that promise at a cost that grew with the whole thread
  // on every streamed token. Instead each update carries a structural copy of
  // only the messages that changed since the last one; an unchanged message
  // reuses its previous copy, so it also keeps its identity across updates.
  // `content` is the working content a copy was made from. Activity content is
  // copied whole, so the copy's own content never equals the working one; the
  // reducer replaces activity content rather than editing it, so comparing
  // against the source reference still detects a change.
  const emittedCopies = new WeakMap<Message, { copy: Message; content: unknown }>();
  const snapshotMessages = (working: Message[]): Message[] =>
    working.map((message) => {
      const previous = emittedCopies.get(message);
      if (previous !== undefined && isUnchangedSince(previous.copy, message, previous.content)) {
        return previous.copy;
      }
      const copy = copyForEmit(message);
      emittedCopies.set(message, { copy, content: message.content });
      return copy;
    });

  const emitUpdates = () => {
    // More events are already waiting: keep collecting into currentMutation,
    // and let the last of them emit the combined update.
    if (coalesce && backlog.waiting > 0) {
      return EMPTY;
    }
    const result: AgentStateMutation = {};
    if (currentMutation.messages !== undefined) {
      result.messages = snapshotMessages(currentMutation.messages);
    }
    // State is copied whole on emit. The agent assigns emitted state to
    // `agent.state`, which apps edit, and the next STATE_DELTA patches the
    // reducer's state, so a shared object would make that edit an unannounced
    // input to later events. State is emitted only when it changed, so text and
    // tool-call streaming do not pay for this copy.
    if (currentMutation.state !== undefined) {
      result.state = structuredClone_(currentMutation.state);
    }
    currentMutation = {};
    if (result.messages !== undefined || result.state !== undefined) {
      return of(result);
    }
    return EMPTY;
  };

  return events$.pipe(
    applyInOrder(async (event: BaseEvent) => {
      const mutation = await runSubscribersWithMutation(
        subscribers,
        messages,
        state,
        (subscriber, messages, state) =>
          subscriber.onEvent?.({ event, agent, input, messages, state }),
      );
      applyMutation(mutation);

      if (mutation.stopPropagation === true) {
        log?.event("APPLY", "Event dropped:", event, {
          type: event.type,
          reason: "stopPropagation by subscriber",
        });
      } else {
        log?.event("APPLY", "Event applied:", event, {
          type: event.type,
          subscribers: subscribers.length,
        });
      }

      if (mutation.stopPropagation === true) {
        return emitUpdates();
      }

      switch (event.type) {
        case EventType.TEXT_MESSAGE_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageStartEvent?.({
                event: event as TextMessageStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const {
              messageId,
              role = "assistant",
              name,
              subagentRunId,
            } = event as TextMessageStartEvent;

            // Check if a message with this ID already exists (e.g., created by TOOL_CALL_START
            // with the same parentMessageId)
            const existingMessage = lookup.find(messages, messageId);

            if (existingMessage?.role === "activity") {
              // Message ids are unique across the conversation, so an activity message under
              // this id means the producer reused it. Streaming text into it would overwrite
              // its structured content with a string. Leave it alone and drop the text — and
              // with it the event's metadata, which describes a text message that never exists.
              console.warn(
                `TEXT_MESSAGE_START: Message '${messageId}' is an activity message — ` +
                  `message ids must be unique across activity and text messages`,
              );
              return emitUpdates();
            }

            // Annotated: the guard above narrows `existingMessage` to the non-activity
            // members, while the message created below is a full `Message`.
            let targetMessage: Message | undefined = existingMessage;

            if (!targetMessage) {
              // Create a new message using properties from the event
              // Text messages can be developer, system, assistant, or user (not tool)
              const newMessage: Message = {
                id: messageId,
                role: role,
                content: "",
                ...(name !== undefined && { name }),
                ...(subagentRunId != null && { subagentRunId }),
              };

              // Add the new message to the messages array
              messages.push(newMessage);
              targetMessage = newMessage;
            }
            // If message already exists, we don't need to create a new one
            // The TEXT_MESSAGE_CONTENT events will update the existing message's content

            const metadataChanged = applyEventMetadata(targetMessage, event);
            if (!existingMessage || metadataChanged) {
              applyMutation({ messages });
            }
          }
          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_CONTENT: {
          const { messageId, delta } = event as TextMessageContentEvent;

          // Find the target message by ID
          const targetMessage = lookup.find(messages, messageId);
          if (!targetMessage) {
            console.warn(`TEXT_MESSAGE_CONTENT: No message found with ID '${messageId}'`);
            return emitUpdates();
          }
          if (targetMessage.role === "activity") {
            // Appending here would replace the activity message's structured content with a
            // string, leaving it no longer a valid ActivityMessage.
            console.warn(
              `TEXT_MESSAGE_CONTENT: Message '${messageId}' is an activity message — ` +
                `message ids must be unique across activity and text messages`,
            );
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageContentEvent?.({
                event: event as TextMessageContentEvent,
                messages,
                state,
                agent,
                input,
                textMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            // Append content to the correct message by ID
            const existingContent =
              typeof targetMessage.content === "string" ? targetMessage.content : "";
            targetMessage.content = `${existingContent}${delta}`;
            applyEventMetadata(targetMessage, event);
            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_END: {
          const { messageId } = event as TextMessageEndEvent;

          // Find the target message by ID
          const targetMessage = lookup.find(messages, messageId);
          if (!targetMessage) {
            console.warn(`TEXT_MESSAGE_END: No message found with ID '${messageId}'`);
            return emitUpdates();
          }
          if (targetMessage.role === "activity") {
            // The matching TEXT_MESSAGE_START was dropped for the same reason, so there is no
            // text message to finish — don't announce the activity message as a new one.
            console.warn(
              `TEXT_MESSAGE_END: Message '${messageId}' is an activity message — ` +
                `message ids must be unique across activity and text messages`,
            );
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onTextMessageEndEvent?.({
                event: event as TextMessageEndEvent,
                messages,
                state,
                agent,
                input,
                textMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          // Merge before onNewMessage so subscribers see the completed message.
          // An end event is where late-known values — token usage, finish
          // reason — typically arrive.
          if (mutation.stopPropagation !== true && applyEventMetadata(targetMessage, event)) {
            applyMutation({ messages });
          }

          await Promise.all(
            subscribers.map((subscriber) => {
              return subscriber.onNewMessage?.({
                message: targetMessage,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

          return emitUpdates();
        }

        case EventType.TOOL_CALL_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onToolCallStartEvent?.({
                event: event as ToolCallStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { toolCallId, toolCallName, parentMessageId, subagentRunId } =
              event as ToolCallStartEvent;
            if (!runToolCallIds.includes(toolCallId)) runToolCallIds.push(toolCallId);

            // Applying a start event must be idempotent. The same start can
            // reach this reducer twice — a tool call already carried in
            // `agent.messages` from an earlier run and then replayed by the
            // backend (the HITL path does this when the run re-syncs after
            // `respond()`), or one stream re-delivered over two transports.
            // Appending unconditionally would leave the assistant message
            // holding the id twice, and the second copy stays empty because
            // TOOL_CALL_ARGS resolves to the first match. That malformed
            // message is then what travels back to the provider on the next
            // turn. Resolve the existing entry the same way TOOL_CALL_ARGS
            // does, and do it before resolveOrCreateAssistantMessage so a
            // replay can't append a stray empty assistant message either.
            const ownerMessage = lookup.toolCallOwner(messages, toolCallId) as
              | AssistantMessage
              | undefined;
            const existingToolCall = ownerMessage?.toolCalls?.find((tc) => tc.id === toolCallId);

            if (!activeToolCallIds.has(toolCallId)) {
              activeToolCallIds.add(toolCallId);
              if (existingToolCall) replaceToolCallArgs.add(toolCallId);
            }

            if (existingToolCall) {
              // Update the existing entry instead of pushing a second one, and
              // retain arguments until an args event arrives. Start-only
              // approval resumes must preserve the call already in history.
              const renamed = existingToolCall.function.name !== toolCallName;
              if (renamed) {
                console.warn(
                  `TOOL_CALL_START: tool call '${toolCallId}' already exists with name ` +
                    `'${existingToolCall.function.name}' — updating it to '${toolCallName}'`,
                );
                existingToolCall.function.name = toolCallName;
              }

              if (applyEventMetadata(existingToolCall, event) || renamed) {
                applyMutation({ messages });
              }

              return emitUpdates();
            }

            const lengthBefore = messages.length;
            const targetMessage = resolveOrCreateAssistantMessage(
              messages,
              parentMessageId,
              toolCallId,
              lookup,
            );
            // Created, and no earlier message had its id. A created message is
            // appended, so it is the first with its id exactly when its id was
            // new.
            const wasCreated =
              messages.length !== lengthBefore &&
              lookup.indexOf(messages, targetMessage.id) === messages.length - 1;
            if (wasCreated && subagentRunId != null && targetMessage.subagentRunId === undefined) {
              targetMessage.subagentRunId = subagentRunId;
            }

            targetMessage.toolCalls ??= [];

            // Add the new tool call
            const newToolCall: ToolCall = {
              id: toolCallId,
              type: "function",
              function: {
                name: toolCallName,
                arguments: "",
              },
            };
            targetMessage.toolCalls.push(newToolCall);
            lookup.addedToolCall(messages, targetMessage, toolCallId);

            applyEventMetadata(newToolCall, event);

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TOOL_CALL_ARGS: {
          const { toolCallId, delta } = event as ToolCallArgsEvent;

          // Find the message containing this tool call
          const targetMessage = lookup.toolCallOwner(messages, toolCallId) as AssistantMessage;

          if (!targetMessage) {
            console.warn(
              `TOOL_CALL_ARGS: No message found containing tool call with ID '${toolCallId}'`,
            );
            return emitUpdates();
          }

          // Find the specific tool call
          const targetToolCall = targetMessage.toolCalls?.find((tc) => tc.id === toolCallId);
          if (!targetToolCall) {
            console.warn(`TOOL_CALL_ARGS: No tool call found with ID '${toolCallId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCallBuffer = replaceToolCallArgs.has(toolCallId)
                ? ""
                : targetToolCall.function.arguments;
              const toolCallName = targetToolCall.function.name;
              let partialToolCallArgs = {};
              try {
                // Parse from toolCallBuffer only (before current delta is applied)
                partialToolCallArgs = untruncateJson(toolCallBuffer);
              } catch (_error) {
                // Streaming args are mid-flight and frequently unparseable;
                // fall through with the last good partial object.
              }

              return subscriber.onToolCallArgsEvent?.({
                event: event as ToolCallArgsEvent,
                messages,
                state,
                agent,
                input,
                toolCallBuffer,
                toolCallName,
                partialToolCallArgs,
              });
            },
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            // The first accepted chunk replaces the previous stream lazily;
            // subsequent chunks (including identical text) are real deltas.
            if (replaceToolCallArgs.delete(toolCallId)) {
              targetToolCall.function.arguments = delta;
            } else {
              targetToolCall.function.arguments += delta;
            }
            applyEventMetadata(targetToolCall, event);
            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.TOOL_CALL_END: {
          const { toolCallId } = event as ToolCallEndEvent;

          // Find the message containing this tool call
          const targetMessage = lookup.toolCallOwner(messages, toolCallId) as AssistantMessage;

          if (!targetMessage) {
            console.warn(
              `TOOL_CALL_END: No message found containing tool call with ID '${toolCallId}'`,
            );
            return emitUpdates();
          }

          // Find the specific tool call
          const targetToolCall = targetMessage.toolCalls?.find((tc) => tc.id === toolCallId);
          if (!targetToolCall) {
            console.warn(`TOOL_CALL_END: No tool call found with ID '${toolCallId}'`);
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) => {
              const toolCallArgsString = targetToolCall.function.arguments;
              const toolCallName = targetToolCall.function.name;
              let toolCallArgs = {};
              try {
                toolCallArgs = JSON.parse(toolCallArgsString);
              } catch (_error) {
                // A malformed final payload must not abort the run; downstream
                // sees the empty object.
              }
              return subscriber.onToolCallEndEvent?.({
                event: event as ToolCallEndEvent,
                messages,
                state,
                agent,
                input,
                toolCallName,
                toolCallArgs,
              });
            },
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            activeToolCallIds.delete(toolCallId);
            replaceToolCallArgs.delete(toolCallId);
          }

          // Merge before onNewToolCall, for the same reason as TEXT_MESSAGE_END:
          // an end event carries the values only known once the call is closed.
          if (mutation.stopPropagation !== true && applyEventMetadata(targetToolCall, event)) {
            applyMutation({ messages });
          }

          await Promise.all(
            subscribers.map((subscriber) => {
              return subscriber.onNewToolCall?.({
                toolCall: targetToolCall,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

          return emitUpdates();
        }

        case EventType.TOOL_CALL_RESULT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onToolCallResultEvent?.({
                event: event as ToolCallResultEvent,
                messages,
                state,
                agent,
                input,
              }),
          );

          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messageId, toolCallId, content, role, subagentRunId } =
              event as ToolCallResultEvent;
            answeredToolCallIds.add(toolCallId);

            const isThisResult = (message: Message) =>
              message.id === messageId &&
              message.role === "tool" &&
              message.toolCallId === toolCallId;
            // The first message with the id is almost always the answer, or
            // there is none; only a reused id needs the scan past it.
            const firstWithId = lookup.indexOf(messages, messageId);
            let existingIndex = firstWithId;
            if (firstWithId !== -1 && !isThisResult(messages[firstWithId])) {
              existingIndex = messages.findIndex(
                (message, index) => index > firstWithId && isThisResult(message),
              );
            }
            const toolMessage: ToolMessage = {
              ...(existingIndex !== -1 ? messages[existingIndex] : {}),
              id: messageId,
              toolCallId,
              role: role || "tool",
              content: content,
              ...(subagentRunId != null && { subagentRunId }),
            };

            // A correction reassigns ownership, including back to the parent
            // when its tag is absent, just as the verifier records it.
            if (subagentRunId == null) delete toolMessage.subagentRunId;

            applyEventMetadata(toolMessage, event);

            // A resumed run may correct a result already present in history.
            // Keep its position and metadata; a repeated message ID is an update.
            if (existingIndex !== -1) {
              messages[existingIndex] = toolMessage;
            } else {
              // Place the tool result immediately after the assistant message that
              // issued the matching tool call — not at the end. A result event can
              // arrive after a trailing assistant text message (e.g. a
              // chat -> tool -> chat loop streams the follow-up text before the
              // result is recorded). Appending would leave the history as
              // assistant(tool_call) -> text -> tool, which violates the provider
              // contract that an assistant tool_call is immediately followed by its
              // tool result and surfaces downstream as a 400.
              //
              // Providers reuse ids such as `call_0` every turn, so several
              // assistant messages can hold the call id. Holders and tool
              // messages are matched by call id alone, as in
              // keepToolResultsWithCalls: a result's subagentRunId names the run
              // that executed it, which may differ from the run that issued the
              // call. The owner is the newest holder that has no tool message
              // with that id between it and the next holder (or the end); if
              // every holder has one, the newest holder. The result goes after
              // the owner and after every tool, activity or non-object entry
              // directly behind it — any call's results, not only this one's, so
              // parallel results keep their order, and activity, which never
              // goes to the backend. keepToolResultsWithCalls treats a result
              // there as in place while the owner has an unanswered call with
              // that id, so a later snapshot leaves it there. Fall back to
              // append when no assistant message holds the id.
              let ownerIndex = -1;
              let newestHolder = -1;
              let answered = false;
              for (let index = messages.length - 1; index >= 0; index--) {
                const message = messages[index];
                if (
                  roleOf(message) === "tool" &&
                  (message as ToolMessage).toolCallId === toolCallId
                ) {
                  answered = true;
                } else if (issuedCallIds(message).includes(toolCallId)) {
                  if (newestHolder === -1) newestHolder = index;
                  if (!answered) {
                    ownerIndex = index;
                    break;
                  }
                  answered = false;
                }
              }
              if (ownerIndex === -1) ownerIndex = newestHolder;
              if (ownerIndex === -1) {
                messages.push(toolMessage);
              } else {
                let insertAt = ownerIndex + 1;
                while (
                  insertAt < messages.length &&
                  (typeof messages[insertAt] !== "object" ||
                    roleOf(messages[insertAt]) === "tool" ||
                    roleOf(messages[insertAt]) === "activity")
                ) {
                  insertAt++;
                }
                lookup.insertedBefore(messages, insertAt);
                messages.splice(insertAt, 0, toolMessage);
              }

              await Promise.all(
                subscribers.map((subscriber) => {
                  return subscriber.onNewMessage?.({
                    message: toolMessage,
                    messages,
                    state,
                    agent,
                    input,
                  });
                }),
              );
            }

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.STATE_SNAPSHOT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStateSnapshotEvent?.({
                event: event as StateSnapshotEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { snapshot } = event as StateSnapshotEvent;

            // Replace state with the snapshot, copied so that emitted state
            // never aliases the caller's event.
            state = structuredClone_(snapshot);

            applyMutation({ state });
          }

          return emitUpdates();
        }

        case EventType.STATE_DELTA: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStateDeltaEvent?.({
                event: event as StateDeltaEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { delta } = event as StateDeltaEvent;

            try {
              // Apply the JSON Patch operations to the current state without
              // mutating the original. fast-json-patch inserts patch values by
              // reference, so copy the patch first: otherwise the event and the
              // emitted state share those objects and an edit to either
              // changes the other.
              const result = jsonpatch.applyPatch(state, structuredClone_(delta), true, false);
              state = result.newDocument;
              applyMutation({ state });
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `Failed to apply state patch:\nCurrent state: ${JSON.stringify(state, null, 2)}\nPatch operations: ${JSON.stringify(delta, null, 2)}\nError: ${errorMessage}`,
              );
              // If patch failed, only emit updates if there were subscriber mutations
              // This prevents emitting updates when both patch fails AND no subscriber mutations
            }
          }

          return emitUpdates();
        }

        case EventType.MESSAGES_SNAPSHOT: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onMessagesSnapshotEvent?.({
                event: event as MessagesSnapshotEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            // Copied on intake: the reducer edits its working messages in
            // place, and those edits must not reach the caller's event.
            const rawNewMessages = structuredClone_((event as MessagesSnapshotEvent).messages);
            // A runtime null tag reads as absent — it must not persist into state
            // and ride the next run's serialized input (the schemas forbid null;
            // this reducer also runs on unverified inputs).
            const newMessages = rawNewMessages.map((m) => {
              if ((m as { subagentRunId?: string | null }).subagentRunId !== null) return m;
              // Spread + delete: Message is a union, so rest-destructuring is a
              // tsc error (TS2700).
              const copy = { ...m } as typeof m & { subagentRunId?: string | null };
              delete copy.subagentRunId;
              return copy as typeof m;
            });

            // Update existing messages in place and append new snapshot messages,
            // preserving client-only messages the backend leaves out.
            const snapshotMap = new Map(newMessages.map((m) => [m.id, m]));

            // `activity` messages are only sometimes client-only. They never
            // travel back to the backend — `prepareRunAgentInput` strips them
            // from RunAgentInput — so a backend that does not track them cannot
            // put them in the snapshot, and the local copies must be preserved.
            // But a backend that does track them re-delivers the whole set it
            // owns. Since a MESSAGES_SNAPSHOT is a snapshot of every message,
            // once it carries any activity the backend is declaring the complete
            // activity set, and one it leaves out has been removed — preserving
            // it would make the local copy undeletable. So when the snapshot
            // itself carries activity, treat it as the source of truth for
            // activity messages and apply the normal replace semantics.
            //
            // `reasoning` messages are only sometimes client-only. Most backends
            // never include reasoning in the snapshot (it exists purely as
            // streamed REASONING_* events), so dropping local reasoning here
            // would lose it. But a backend that round-trips reasoning (e.g.
            // LangGraph re-deriving it from checkpointed content blocks)
            // re-delivers the streamed reasoning under its own canonical id —
            // message ids are generally NOT stable between streamed events and
            // the snapshot. Preserving the streamed copy next to the snapshot
            // copy would render the same reasoning twice. So when the snapshot
            // itself carries reasoning, treat it as the source of truth for
            // reasoning messages too and apply the normal replace semantics.
            // Explicit null replaces all types, including an empty activity set.
            // Arrays replace only their types; absent declarations use the rule above.
            // Invalid declarations own no types. Matching IDs always update.
            const ownedActivityTypes = authoritativeActivityTypes(event as MessagesSnapshotEvent);
            const snapshotHasActivity = newMessages.some((m) => m.role === "activity");
            const snapshotHasReasoning = newMessages.some((m) => m.role === "reasoning");
            const isPreservedClientOnly = (m: Message) =>
              (m.role === "activity" &&
                (ownedActivityTypes
                  ? !ownedActivityTypes.includes(m.activityType)
                  : ownedActivityTypes !== null && !snapshotHasActivity)) ||
              (m.role === "reasoning" && !snapshotHasReasoning);

            // A matching ID updates even when this snapshot cannot delete that
            // activity type. Authority applies only to messages omitted from it.
            messages = messages
              .filter((m) => snapshotMap.has(m.id) || isPreservedClientOnly(m))
              .map((m) => snapshotMap.get(m.id) ?? m);

            const existingIds = new Set(messages.map((m) => m.id));
            for (const snapshotMsg of newMessages) {
              if (!existingIds.has(snapshotMsg.id)) {
                messages.push(snapshotMsg);
              }
            }
            messages = keepToolResultsWithCalls(messages);

            applyMutation({ messages });
          }

          return emitUpdates();
        }

        case EventType.ACTIVITY_SNAPSHOT: {
          const activityEvent = event as ActivitySnapshotEvent;
          const existingIndex = lookup.indexOf(messages, activityEvent.messageId);
          const existingMessage = existingIndex >= 0 ? messages[existingIndex] : undefined;
          const existingActivityMessage =
            existingMessage?.role === "activity" ? (existingMessage as ActivityMessage) : undefined;
          const replace = activityEvent.replace ?? true;

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onActivitySnapshotEvent?.({
                event: activityEvent,
                messages,
                state,
                agent,
                input,
                activityMessage: existingActivityMessage,
                existingMessage,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const activityMessage: ActivityMessage = {
              id: activityEvent.messageId,
              role: "activity",
              activityType: activityEvent.activityType,
              content: structuredClone_(activityEvent.content),
              ...(activityEvent.subagentRunId != null && {
                subagentRunId: activityEvent.subagentRunId,
              }),
            };

            let createdMessage: ActivityMessage | undefined;
            let mergeTarget: Message | undefined;

            if (existingIndex === -1) {
              messages.push(activityMessage);
              createdMessage = activityMessage;
              mergeTarget = activityMessage;
            } else if (existingActivityMessage) {
              if (replace) {
                // Spread carries the accumulated metadata across the replace —
                // a snapshot replaces content, not the metadata built up so far.
                // Attribution is the exception: a replace snapshot re-mints the
                // activity, so it brings its own subagentRunId with it (D4: a
                // creation event's tag transfers to the message it mints). Keeping
                // the old owner here left a subagent's replacement parent-owned —
                // and, in the other direction, a parent snapshot could never
                // reclaim an activity a subagent had taken.
                messages[existingIndex] = {
                  ...existingActivityMessage,
                  activityType: activityEvent.activityType,
                  content: structuredClone_(activityEvent.content),
                  subagentRunId: activityEvent.subagentRunId,
                };
                if (activityEvent.subagentRunId == null) {
                  delete (messages[existingIndex] as { subagentRunId?: string }).subagentRunId;
                }
              }
              mergeTarget = messages[existingIndex];
            } else if (replace) {
              messages[existingIndex] = activityMessage;
              createdMessage = activityMessage;
              mergeTarget = activityMessage;
            }

            applyEventMetadata(mergeTarget, activityEvent);

            applyMutation({ messages });

            if (createdMessage) {
              await Promise.all(
                subscribers.map((subscriber) =>
                  subscriber.onNewMessage?.({
                    message: createdMessage,
                    messages,
                    state,
                    agent,
                    input,
                  }),
                ),
              );
            }
          }

          return emitUpdates();
        }

        case EventType.ACTIVITY_DELTA: {
          const activityEvent = event as ActivityDeltaEvent;
          const existingIndex = lookup.indexOf(messages, activityEvent.messageId);
          if (existingIndex === -1) {
            return emitUpdates();
          }

          const existingMessage = messages[existingIndex];
          if (existingMessage.role !== "activity") {
            console.warn(
              `ACTIVITY_DELTA: Message '${activityEvent.messageId}' is not an activity message`,
            );
            return emitUpdates();
          }

          const existingActivityMessage = existingMessage as ActivityMessage;

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onActivityDeltaEvent?.({
                event: activityEvent,
                messages,
                state,
                agent,
                input,
                activityMessage: existingActivityMessage,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            try {
              // Metadata does not depend on the patch succeeding — a stale path
              // should not cost the message its usage or trace keys — so merge
              // it before attempting the patch and emit it either way.
              if (applyEventMetadata(existingActivityMessage, activityEvent)) {
                applyMutation({ messages });
              }

              const baseContent = structuredClone_(existingActivityMessage.content ?? {});

              const result = jsonpatch.applyPatch(
                baseContent,
                activityEvent.patch ?? [],
                true,
                false,
              );
              const updatedContent = result.newDocument as ActivityMessage["content"];

              // The spread carries the metadata merged above.
              messages[existingIndex] = {
                ...existingActivityMessage,
                content: structuredClone_(updatedContent),
                activityType: activityEvent.activityType,
              };

              applyMutation({ messages });
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              console.warn(
                `Failed to apply activity patch for '${activityEvent.messageId}': ${errorMessage}`,
              );
            }
          }

          return emitUpdates();
        }

        case EventType.RAW: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRawEvent?.({
                event: event as RawEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.CUSTOM: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onCustomEvent?.({
                event: event as CustomEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.RUN_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunStartedEvent?.({
                event: event as RunStartedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          // A new run starts a new tally: pending calls are run-scoped.
          runToolCallIds = [];
          answeredToolCallIds = new Set<string>();

          // Handle input.messages if present and stopPropagation is not set
          if (mutation.stopPropagation !== true) {
            activeToolCallIds.clear();
            replaceToolCallArgs.clear();
            const runStartedEvent = event as RunStartedEvent;

            // Check if the event contains input with messages
            if (runStartedEvent.input?.messages) {
              // Add messages that aren't already present (checked by ID)
              for (const rawMessage of runStartedEvent.input.messages) {
                // Same null-as-absent rule as the snapshot merge above.
                let message = rawMessage;
                if ((rawMessage as { subagentRunId?: string | null }).subagentRunId === null) {
                  const copy = { ...rawMessage } as typeof rawMessage & {
                    subagentRunId?: string | null;
                  };
                  delete copy.subagentRunId;
                  message = copy as typeof rawMessage;
                }
                const existingMessage = lookup.find(messages, message.id);
                if (!existingMessage) {
                  messages.push(message);
                }
              }

              // Apply mutation to emit the updated messages
              applyMutation({ messages });
            }
          }

          return emitUpdates();
        }

        case EventType.RUN_FINISHED: {
          const e = event as RunFinishedEvent;
          // Absent means success; a cancelled run carries neither a result nor
          // anything to answer, so its params are the bare event.
          const finishedParams =
            e.outcome?.type === "interrupt"
              ? ({
                  event: e,
                  outcome: "interrupt" as const,
                  interrupts: e.outcome.interrupts,
                } as const)
              : e.outcome?.type === "cancelled"
                ? ({ event: e, outcome: "cancelled" as const } as const)
                : ({
                    event: e,
                    outcome: "success" as const,
                    result: e.result,
                    pendingToolCallIds: pendingToolCallIdsOf(e),
                  } as const);
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunFinishedEvent?.({
                ...finishedParams,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          // Update pending interrupts AFTER subscribers run, and only if no
          // subscriber suppressed the event — matches the lifecycle pattern
          // used by every other case in this switch. Defensive-copy the
          // interrupt list so consumers that hold the original event payload
          // can't mutate the agent's tracked state through array aliasing.
          if (mutation.stopPropagation !== true) {
            agent.pendingInterrupts =
              finishedParams.outcome === "interrupt"
                ? finishedParams.interrupts.map((interrupt) => {
                    if ((interrupt as { subagentRunId?: string | null }).subagentRunId !== null) {
                      return interrupt;
                    }
                    const copy = { ...interrupt } as typeof interrupt & {
                      subagentRunId?: string | null;
                    };
                    delete copy.subagentRunId;
                    return copy as typeof interrupt;
                  })
                : [];
          }

          return emitUpdates();
        }

        case EventType.RUN_ERROR: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onRunErrorEvent?.({
                event: event as RunErrorEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.STEP_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStepStartedEvent?.({
                event: event as StepStartedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.STEP_FINISHED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onStepFinishedEvent?.({
                event: event as StepFinishedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          return emitUpdates();
        }

        case EventType.TEXT_MESSAGE_CHUNK: {
          throw new Error("TEXT_MESSAGE_CHUNK must be transformed before being applied");
        }

        case EventType.TOOL_CALL_CHUNK: {
          throw new Error("TOOL_CALL_CHUNK must be transformed before being applied");
        }

        case EventType.REASONING_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningStartEvent?.({
                event: event as ReasoningStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_START: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningMessageStartEvent?.({
                event: event as ReasoningMessageStartEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const { messageId, subagentRunId } = event as ReasoningMessageStartEvent;
            const existingMessage = lookup.find(messages, messageId);

            if (existingMessage?.role === "activity") {
              // Message ids are unique across the conversation, so an activity message under
              // this id means the producer reused it. Streaming reasoning into it would
              // overwrite its structured content with a string. Leave it alone and drop the
              // event — and with it its metadata, which describes a reasoning message that
              // never exists.
              console.warn(
                `REASONING_MESSAGE_START: Message '${messageId}' is an activity message — ` +
                  `message ids must be unique across activity and reasoning messages`,
              );
              return emitUpdates();
            }

            let targetMessage = existingMessage;

            if (!targetMessage) {
              const newMessage: ReasoningMessage = {
                id: messageId,
                role: "reasoning",
                content: "",
                ...(subagentRunId != null && { subagentRunId }),
              };
              messages.push(newMessage);
              targetMessage = newMessage;
            }

            const metadataChanged = applyEventMetadata(targetMessage, event);
            if (!existingMessage || metadataChanged) {
              applyMutation({ messages });
            }
          }
          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_CONTENT: {
          const { messageId, delta } = event as ReasoningMessageContentEvent;

          const targetMessage = lookup.find(messages, messageId);
          if (!targetMessage) {
            console.warn(`REASONING_MESSAGE_CONTENT: No message found with ID '${messageId}'`);
            return emitUpdates();
          }
          if (targetMessage.role === "activity") {
            // Appending here would replace the activity message's structured content with a
            // string, leaving it no longer a valid ActivityMessage.
            console.warn(
              `REASONING_MESSAGE_CONTENT: Message '${messageId}' is an activity message — ` +
                `message ids must be unique across activity and reasoning messages`,
            );
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningMessageContentEvent?.({
                event: event as ReasoningMessageContentEvent,
                messages,
                state,
                agent,
                input,
                reasoningMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true) {
            const existingContent =
              typeof targetMessage.content === "string" ? targetMessage.content : "";
            targetMessage.content = `${existingContent}${delta}`;
            applyEventMetadata(targetMessage, event);
            applyMutation({ messages });
          }
          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_END: {
          const { messageId } = event as ReasoningMessageEndEvent;

          const targetMessage = lookup.find(messages, messageId);
          if (!targetMessage) {
            console.warn(`REASONING_MESSAGE_END: No message found with ID '${messageId}'`);
            return emitUpdates();
          }
          if (targetMessage.role === "activity") {
            // The matching REASONING_MESSAGE_START was dropped for the same reason, so there
            // is no reasoning message to finish — don't announce the activity message as one.
            console.warn(
              `REASONING_MESSAGE_END: Message '${messageId}' is an activity message — ` +
                `message ids must be unique across activity and reasoning messages`,
            );
            return emitUpdates();
          }

          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningMessageEndEvent?.({
                event: event as ReasoningMessageEndEvent,
                messages,
                state,
                agent,
                input,
                reasoningMessageBuffer:
                  typeof targetMessage.content === "string" ? targetMessage.content : "",
              }),
          );
          applyMutation(mutation);

          if (mutation.stopPropagation !== true && applyEventMetadata(targetMessage, event)) {
            applyMutation({ messages });
          }

          await Promise.all(
            subscribers.map((subscriber) => {
              return subscriber.onNewMessage?.({
                message: targetMessage,
                messages,
                state,
                agent,
                input,
              });
            }),
          );

          return emitUpdates();
        }

        case EventType.REASONING_MESSAGE_CHUNK: {
          throw new Error("REASONING_MESSAGE_CHUNK must be transformed before being applied");
        }

        case EventType.REASONING_END: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningEndEvent?.({
                event: event as ReasoningEndEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }

        // REASONING_ENCRYPTED_VALUE attaches an encrypted blob to an entity that
        // already exists; it does not build one, so its metadata stays on the
        // event, like REASONING_START and REASONING_END. That also keeps the
        // compaction invariant intact: `compactEvents` buffers an event arriving
        // mid-stream and flushes it *after* the END it originally preceded, so
        // merging its metadata into the same entity would make a compacted
        // replay disagree with the original stream.
        case EventType.REASONING_ENCRYPTED_VALUE: {
          const { subtype, entityId, encryptedValue } = event as ReasoningEncryptedValueEvent;
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onReasoningEncryptedValueEvent?.({
                event: event as ReasoningEncryptedValueEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          if (mutation.stopPropagation !== true) {
            let entityUpdated = false;
            if (subtype === "tool-call") {
              // Find tool call by entityId and set encryptedValue
              for (const message of messages) {
                if (message.role === "assistant" && message.toolCalls) {
                  const toolCall = message.toolCalls.find((tc) => tc.id === entityId);
                  if (toolCall) {
                    toolCall.encryptedValue = encryptedValue;
                    entityUpdated = true;
                    break;
                  }
                }
              }
            } else {
              // subtype is "message"
              // Find message by entityId and set encryptedValue
              const message = lookup.find(messages, entityId);
              // Activity messages do not have encryptedValue
              if (message?.role !== "activity" && message) {
                message.encryptedValue = encryptedValue;
                entityUpdated = true;
              }
            }
            if (entityUpdated) {
              currentMutation.messages = messages;
            }
          }
          return emitUpdates();
        }

        case EventType.SUBAGENT_STARTED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onSubagentStartedEvent?.({
                event: event as SubagentStartedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }

        case EventType.SUBAGENT_FINISHED: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onSubagentFinishedEvent?.({
                event: event as SubagentFinishedEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }

        case EventType.SUBAGENT_ERROR: {
          const mutation = await runSubscribersWithMutation(
            subscribers,
            messages,
            state,
            (subscriber, messages, state) =>
              subscriber.onSubagentErrorEvent?.({
                event: event as SubagentErrorEvent,
                messages,
                state,
                agent,
                input,
              }),
          );
          applyMutation(mutation);
          return emitUpdates();
        }
      }

      // This makes TypeScript check that the switch is exhaustive
      // If a new EventType is added, this will cause a compile error
      const _exhaustiveCheck: never = event.type;
      return emitUpdates();
    }, backlog),
    // Only use defaultIfEmpty when there are subscribers to avoid emitting empty updates
    // when patches fail and there are no subscribers (like in state patching test)
    subscribers.length > 0 ? defaultIfEmpty({} as AgentStateMutation) : <T>(stream: T) => stream,
  );
};
