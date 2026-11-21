import { restoreStateHistory } from "./state";
import { restoreContext } from "./context";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import type { SessionRecord } from "./types";
import { textOf } from "./text";
import { toolContent } from "./content";

export class RecoveryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SessionStream =
  AsyncIterable<BetaManagedAgentsStreamSessionEvents> & {
    controller: AbortController;
  };

/** Inspect just the first event of the newest page, even when more pages exist. */
async function historyEndsAt(
  client: Anthropic,
  sessionId: string,
  eventId: string,
  signal: AbortSignal,
) {
  for await (const event of client.beta.sessions.events.list(
    sessionId,
    { order: "desc", limit: 1 },
    { signal },
  )) {
    return (
      event.id === eventId &&
      event.type === "session.status_idle" &&
      event.stop_reason.type === "end_turn"
    );
  }
  return false;
}

// A root end_turn closes all earlier calls. Only look up their IDs if the
// service later repeats requires_action for a call absent from the live stream.
async function answeredBeforeEnd(
  client: Anthropic,
  sessionId: string,
  endId: string,
  signal: AbortSignal,
) {
  const answered = new Set<string>();
  for await (const event of client.beta.sessions.events.list(
    sessionId,
    {},
    { signal },
  )) {
    if (event.id === endId) return answered;
    if (
      event.type === "agent.custom_tool_use" ||
      ((event.type === "agent.tool_use" ||
        event.type === "agent.mcp_tool_use") &&
        event.evaluated_permission === "ask")
    ) {
      answered.add(event.id);
    }
    const result = answeredCallId(event);
    if (result) answered.add(result);
  }
  throw new RecoveryError(
    "history_cursor_unavailable",
    "The saved event position is no longer available in native history.",
  );
}

function answeredCallId(event: BetaManagedAgentsSessionEvent) {
  switch (event.type) {
    case "user.custom_tool_result":
      return event.custom_tool_use_id;
    case "agent.mcp_tool_result":
      return event.mcp_tool_use_id;
    case "user.tool_confirmation":
    case "agent.tool_result":
      return event.tool_use_id;
  }
}

function unseenEvents(
  stream: SessionStream,
  seen: Set<string>,
  loadEarlierAnswers?: () => Promise<Set<string>>,
): SessionStream {
  return {
    controller: stream.controller,
    async *[Symbol.asyncIterator]() {
      let earlierAnswers: Set<string> | undefined;
      for await (const event of stream) {
        if (
          event.type === "event_start" ||
          event.type === "event_delta" ||
          seen.has(event.id)
        )
          continue;
        seen.add(event.id);
        if (
          loadEarlierAnswers &&
          event.type === "session.status_idle" &&
          event.stop_reason.type === "requires_action" &&
          event.stop_reason.event_ids?.some((id) => !seen.has(id))
        ) {
          const answered = (earlierAnswers ??= await loadEarlierAnswers());
          const outstanding = event.stop_reason.event_ids.filter(
            (id) => !answered.has(id),
          );
          yield {
            ...event,
            stop_reason: { ...event.stop_reason, event_ids: outstanding },
          };
        } else {
          yield event;
        }
      }
    },
  };
}

/** Open first, then reconcile history; only unseen live events reach the turn. */
export async function recoverSession(
  client: Anthropic,
  record: SessionRecord,
  signal: AbortSignal,
  emit: (event: BaseEvent) => void,
  knownToolCalls: Set<string> = new Set(),
  clientTools: Map<string, string> = new Map(),
  knownMessages: Map<string, unknown> = new Map(),
  cleanEndEventId?: string,
) {
  if (record.ended)
    throw new RecoveryError(
      "session_ended",
      "The original managed session has ended.",
    );
  let stream: SessionStream | undefined;
  try {
    const session = await client.beta.sessions.retrieve(
      record.sessionId,
      {},
      { signal },
    );
    if (session.status === "terminated")
      throw new RecoveryError(
        "session_ended",
        "The original managed session has ended.",
      );
    stream = record.sessionThreadId
      ? await client.beta.sessions.threads.events.stream(
          record.sessionThreadId,
          { session_id: record.sessionId },
          { signal },
        )
      : await client.beta.sessions.events.stream(
          record.sessionId,
          {},
          { signal },
        );
    if (
      cleanEndEventId !== undefined &&
      cleanEndEventId === record.lastEventId &&
      !record.sessionThreadId &&
      session.status === "idle" &&
      record.pendingClientToolUseIds.length === 0 &&
      !record.pendingConfirmations?.length &&
      (await historyEndsAt(client, record.sessionId, cleanEndEventId, signal))
    ) {
      return {
        pending: [],
        answeredIds: new Set<string>(),
        replayedIds: new Set<string>(),
        running: false,
        stream: unseenEvents(stream, new Set([cleanEndEventId]), () =>
          answeredBeforeEnd(client, record.sessionId, cleanEndEventId, signal),
        ),
      };
    }
    const history = record.sessionThreadId
      ? client.beta.sessions.threads.events.list(
          record.sessionThreadId,
          { session_id: record.sessionId },
          { signal },
        )
      : client.beta.sessions.events.list(record.sessionId, {}, { signal });
    const seen = new Set<string>();
    const ordered: BetaManagedAgentsSessionEvent[] = [];
    const calls = new Map<string, BetaManagedAgentsSessionEvent>();
    const answered = new Set<string>();
    const blocking = new Set<string>();
    let ended = false;
    let running =
      session.status === "running" || session.status === "rescheduling";
    for await (const event of history) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      ordered.push(event);
      if (event.type === "system.message")
        restoreContext(event.content, record);
      const result = answeredCallId(event);
      if (result) answered.add(result);
      switch (event.type) {
        case "session.status_running":
          if (!record.sessionThreadId) running = true;
          break;
        case "session.thread_status_running":
          if (record.sessionThreadId === event.session_thread_id)
            running = true;
          break;
        case "agent.custom_tool_use":
          calls.set(event.id, event);
          break;
        case "agent.tool_use":
        case "agent.mcp_tool_use":
          if (event.evaluated_permission === "ask") calls.set(event.id, event);
          break;
        case "session.status_idle":
        case "session.thread_status_idle":
          if (
            (event.type === "session.status_idle" && !record.sessionThreadId) ||
            (event.type === "session.thread_status_idle" &&
              record.sessionThreadId === event.session_thread_id)
          )
            running = false;
          if (event.stop_reason.type === "requires_action") {
            for (const id of event.stop_reason.event_ids) blocking.add(id);
          } else if (event.stop_reason.type === "end_turn") {
            for (const [id, call] of calls) {
              if (
                event.type === "session.status_idle" ||
                ("session_thread_id" in call &&
                  call.session_thread_id === event.session_thread_id)
              )
                answered.add(id);
            }
          }
          break;
        case "session.status_terminated":
        case "session.deleted":
          ended = true;
          break;
        case "session.thread_status_terminated":
          if (record.sessionThreadId === event.session_thread_id) ended = true;
          else
            for (const [id, call] of calls) {
              if (
                "session_thread_id" in call &&
                call.session_thread_id === event.session_thread_id
              )
                answered.add(id);
            }
          break;
      }
    }
    await restoreStateHistory(client, record, ordered, signal);
    if (ended)
      throw new RecoveryError(
        "session_ended",
        "The original managed session or thread has ended.",
      );
    if ([...blocking].some((id) => !calls.has(id) && !answered.has(id))) {
      throw new RecoveryError(
        "pending_request_unavailable",
        "A pending request is missing from the available native history.",
      );
    }
    for (const event of ordered) rememberChildCall(record, event);
    const pending = [...calls.values()].filter(
      (event) => !answered.has(event.id),
    );
    const cursorIndex = record.lastEventId
      ? ordered.findIndex((event) => event.id === record.lastEventId)
      : -1;
    if (record.lastEventId && cursorIndex < 0 && ordered.length) {
      throw new RecoveryError(
        "history_cursor_unavailable",
        "The saved event position is no longer available in native history.",
      );
    }
    const missed =
      cursorIndex >= 0
        ? ordered.slice(cursorIndex + 1)
        : record.preserveTools
          ? []
          : ordered;
    for (const event of missed)
      emitRecoveredActivity(
        event,
        emit,
        knownToolCalls,
        clientTools,
        knownMessages,
      );
    record.lastEventId = ordered.at(-1)?.id ?? record.lastEventId;
    // An empty history cannot invalidate a previously persisted call (e.g. retention).
    if (seen.size > 0) {
      record.pendingClientToolUseIds = pending
        .filter((event) => event.type === "agent.custom_tool_use")
        .map((event) => event.id);
      record.pendingConfirmations = pending.flatMap((event) =>
        event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use"
          ? [
              {
                id: event.id,
                toolName: event.name,
                ...(event.session_thread_id
                  ? { sessionThreadId: event.session_thread_id }
                  : {}),
              },
            ]
          : [],
      );
    }
    return {
      pending,
      answeredIds: answered,
      replayedIds: new Set(missed.map((event) => event.id)),
      running,
      stream: unseenEvents(stream, seen),
    };
  } catch (error) {
    stream?.controller.abort();
    if (error instanceof RecoveryError) throw error;
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      [403, 404, 410].includes(Number(error.status))
    ) {
      throw new RecoveryError(
        "session_unavailable",
        "The original managed session is unavailable or access was denied.",
      );
    }
    throw error;
  }
}

/** Replay persisted activity only. In particular, never execute historical tools. */
function emitRecoveredActivity(
  event: BetaManagedAgentsSessionEvent,
  emit: (event: BaseEvent) => void,
  knownToolCalls: Set<string>,
  clientTools: Map<string, string>,
  knownMessages: Map<string, unknown>,
) {
  emit({
    type: EventType.RAW,
    source: "claude-managed-agents",
    event,
  } as BaseEvent);
  if (event.type === "agent.message") {
    let content = textOf(event.content);
    const existing = knownMessages.get(event.id);
    if (typeof existing === "string") {
      if (!content.startsWith(existing))
        throw new RecoveryError(
          "history_content_conflict",
          "Saved native text conflicts with the existing message.",
        );
      content = content.slice(existing.length);
    }
    if (!content) return;
    emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: event.id,
      role: "assistant",
    } as BaseEvent);
    emit({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: event.id,
      delta: content,
    } as BaseEvent);
    emit({
      type: EventType.TEXT_MESSAGE_END,
      messageId: event.id,
    } as BaseEvent);
  } else if (
    event.type === "agent.custom_tool_use" ||
    event.type === "agent.tool_use" ||
    event.type === "agent.mcp_tool_use"
  ) {
    if (knownToolCalls.has(event.id)) return;
    emit({
      type: EventType.TOOL_CALL_START,
      toolCallId: event.id,
      toolCallName:
        event.type === "agent.custom_tool_use"
          ? (clientTools.get(event.name) ?? event.name)
          : event.name,
    } as BaseEvent);
    emit({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: event.id,
      delta: JSON.stringify(event.input ?? {}),
    } as BaseEvent);
    emit({ type: EventType.TOOL_CALL_END, toolCallId: event.id } as BaseEvent);
  } else if (
    event.type === "agent.tool_result" ||
    event.type === "agent.mcp_tool_result" ||
    event.type === "user.custom_tool_result"
  ) {
    if (knownMessages.has(event.id)) return;
    const toolCallId =
      event.type === "agent.tool_result"
        ? event.tool_use_id
        : event.type === "agent.mcp_tool_result"
          ? event.mcp_tool_use_id
          : event.custom_tool_use_id;
    emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: event.id,
      toolCallId,
      role: "tool",
      content: toolContent(event.content, event.is_error === true),
    } as BaseEvent);
  }
}

export function recoveryFinished(
  record: SessionRecord,
  threadId: string,
  runId: string,
): BaseEvent {
  const interrupts = (record.pendingConfirmations ?? []).map((call) => ({
    id: call.id,
    toolCallId: call.id,
    reason: "tool-approval",
    responseSchema: { type: "string", enum: ["allow", "deny"] },
    metadata: {
      sessionId: record.sessionId,
      toolName: call.toolName,
      ...(call.sessionThreadId
        ? { sessionThreadId: call.sessionThreadId }
        : {}),
    },
  }));
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    ...(interrupts.length
      ? { outcome: { type: "interrupt", interrupts } }
      : {}),
  } as BaseEvent;
}

/** Only native root cross-posts establish child ownership. */
export function rememberChildCall(
  record: SessionRecord,
  event: BetaManagedAgentsSessionEvent,
) {
  if (
    !record.sessionThreadId &&
    (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use") &&
    event.session_thread_id
  ) {
    (record.childToolCalls ??= {})[event.id] = event.session_thread_id;
  }
}

/** Root cursors and timestamps cannot bound child history. */
export async function recoverChildResults(
  client: Anthropic,
  record: SessionRecord,
  signal: AbortSignal,
  emit: (event: BaseEvent) => void,
  persist: () => void | Promise<void>,
) {
  if (record.sessionThreadId) return;
  const delivered = new Set(record.deliveredChildResultIds ?? []);
  const calls = Object.entries(record.childToolCalls ?? {}).filter(
    ([id]) => !delivered.has(id),
  );
  for (const thread of new Set(calls.map(([, thread]) => thread))) {
    for await (const event of client.beta.sessions.threads.events.list(
      thread,
      { session_id: record.sessionId },
      { signal },
    )) {
      if (
        event.type !== "agent.tool_result" &&
        event.type !== "agent.mcp_tool_result"
      )
        continue;
      const callId =
        event.type === "agent.tool_result"
          ? event.tool_use_id
          : event.type === "agent.mcp_tool_result"
            ? event.mcp_tool_use_id
            : undefined;
      if (
        !callId ||
        record.childToolCalls?.[callId] !== thread ||
        delivered.has(callId)
      )
        continue;
      if (
        "session_thread_id" in event &&
        event.session_thread_id &&
        event.session_thread_id !== thread
      )
        continue;
      const scoped = { ...event, session_thread_id: thread };
      emitRecoveredActivity(scoped, emit, new Set(), new Map(), new Map());
      delivered.add(callId);
      await persist();
    }
  }
}
