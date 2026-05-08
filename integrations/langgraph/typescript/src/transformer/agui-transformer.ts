/**
 * AG-UI StreamTransformer.
 *
 * Wired into a graph at compile time via `streamTransformers: [aguiTransformer]`.
 * Exposes a named `agui` channel reached by SDK clients via `thread.extensions.agui`.
 *
 * Phase 3: per-event-family handlers. The transformer translates each
 * langgraph `ProtocolEvent` into one or more AG-UI events and pushes them
 * onto the `agui` channel. Phase 3.1 implements:
 *   - lifecycle  → RUN_STARTED / RUN_FINISHED / RUN_ERROR
 *   - messages   → TEXT_MESSAGE_START / _CONTENT / _END
 * Other families (tool calls, state snapshots, interrupts, reasoning, custom)
 * land in subsequent phases.
 */

import {
  StreamChannel,
  type ProtocolEvent,
  type StreamTransformer,
} from "@langchain/langgraph";
import { langchainMessagesToAgui } from "../utils";
import { LangGraphEventTypes, ProcessedEvents, State } from "../types";
import { EventType } from "@ag-ui/core";

/**
 * Minimal AG-UI event shape. Loose dictionary so this module has no
 * cross-package import on `@ag-ui/core`. Tighten to the real `BaseEvent`
 * union once a shared transformer package exists.
 */

/**
 * Factory returning the transformer instance. Each run gets a fresh remote
 * `agui` channel; SDK clients consume via `thread.extensions.agui`.
 */
export const aguiTransformer = (): StreamTransformer<{
  agui: StreamChannel<ProcessedEvents>;
}> => {
  const aguiChannel = StreamChannel.remote<ProcessedEvents>("agui");
  let initialized = false;
  let runStartedEmitted = false;

  // Per-message tracking for text streaming. Keyed by content-block index so
  // multi-block messages (e.g. text + tool call in one assistant turn) don't
  // collide on a single shared id.
  const textBlockMessageIds = new Map<number, string>();
  // Per-tool-call tracking. Keyed by content-block index. Each tool call
  // occupies one block; the chunk's id may be null until later updates so we
  // also remember the assigned toolCallId here. `argsSoFar` carries the
  // cumulative `args` string the engine has reported — block-delta carries
  // the FULL accumulated value each time, not an incremental piece, so we
  // diff against this to derive the delta AG-UI expects.
  const toolBlocks = new Map<
    number,
    { toolCallId: string; toolCallName: string; argsSoFar: string }
  >();
  let activeMessageId: string | undefined;

  // Per-run set of interrupt ids already converted into CUSTOM
  // `OnInterrupt` pushes. Each `tasks` event carrying interrupts can
  // fire multiple times during the run (input + result frames); dedup
  // by interrupt id so the client only renders one prompt.
  const emittedInterruptIds = new Set<string>();

  const push = (ev: ProcessedEvents) => {
    aguiChannel.push(ev);
  };

  // langgraph delivers `lifecycle.started` before init() has run, so we
  // would drop the event that maps to RUN_STARTED. Synthesise it lazily on
  // the first post-init process call instead. AG-UI's verify enforces
  // RUN_STARTED as the first event on the wire.
  const ensureRunStarted = () => {
    if (runStartedEmitted) return;
    runStartedEmitted = true;
  };

  const isRootNamespace = (ns: readonly string[]) => ns.length === 0;

  // Defer snapshot emission until the run reaches a stable point. Each
  // Pregel step (including transient sub-steps inside copilotkitMiddleware
  // that intercept then restore tool calls) emits its own `values` event;
  // pushing a MESSAGES_SNAPSHOT for each one ships the in-between dip where
  // the assistant message has lost its tool calls. Mirrors the legacy
  // agent's behaviour, which only reads the canonical persisted state at
  // run end.
  let latestState: State | null = null;
  let lastMessagesSnapshotHash = "";
  let lastStateSnapshotHash = "";

  const cacheState = (state: State) => {
    if (!state || typeof state !== "object") return;
    // Shallow-merge instead of replace. Subsequent root `values` events
    // may carry only the keys that just changed (e.g. an interrupt
    // update without `messages` rebroadcast); replacing wholesale would
    // drop the unchanged keys and ship an empty MESSAGES_SNAPSHOT,
    // which CopilotKit treats as "no messages" and resets the UI.
    latestState = { ...(latestState ?? {}), ...state };
  };

  const flushSnapshots = () => {
    if (!latestState) return;
    const state = latestState;

    const { messages: _m, ...stateOnly } = state;
    const stateHash = JSON.stringify(stateOnly);
    if (stateHash !== lastStateSnapshotHash) {
      lastStateSnapshotHash = stateHash;
      push({ type: EventType.STATE_SNAPSHOT, snapshot: stateOnly });
    }

    const lcMessages = state.messages ?? [];
    const aguiMessages = langchainMessagesToAgui(lcMessages);
    const msgHash = JSON.stringify(aguiMessages);
    if (msgHash !== lastMessagesSnapshotHash) {
      lastMessagesSnapshotHash = msgHash;
      push({ type: EventType.MESSAGES_SNAPSHOT, messages: aguiMessages });
    }
  };

  let runFinishedEmitted = false;
  let runErrorEmitted = false;

  return {
    init() {
      initialized = true;
      return { agui: aguiChannel };
    },

    finalize() {
      // Lifecycle (RUN_*) is owned by agent.ts. Here we only close any
      // text/tool blocks that didn't receive their `content-block-finish`
      // before the run ended, so AG-UI verify doesn't reject the terminal
      // event downstream.
      for (const [index, messageId] of textBlockMessageIds) {
        push({ type: EventType.TEXT_MESSAGE_END, messageId });
        textBlockMessageIds.delete(index);
      }
      for (const [index, tool] of toolBlocks) {
        push({ type: EventType.TOOL_CALL_END, toolCallId: tool.toolCallId });
        toolBlocks.delete(index);
      }
    },

    process(event: ProtocolEvent): boolean {
      // Mux wires the channel only after init() returns. Pushes before then
      // are dropped on the wire. Skip until init has completed.
      if (!initialized) return true;

      switch (event.method) {
        case "lifecycle": {
          // Lifecycle bracketing (RUN_STARTED / RUN_FINISHED) is owned by
          // agent.ts. Here we only forward fatal failures so the client can
          // surface the underlying message instead of a generic
          // INCOMPLETE_STREAM error.
          if (!isRootNamespace(event.params.namespace)) break;
          const status = (event.params.data as { event?: string } | undefined)?.event;
          if (status === "completed" || status === "interrupted") {
            // Stable point: the run is paused (interrupted) or done
            // (completed). The state we cached from the last `values`
            // event reflects the canonical shape at this boundary.
            // Flush snapshots so consumers see updated state at both
            // run end and interrupt — HITL graphs land here on every
            // interrupt() call.
            flushSnapshots();
          } else if (status === "failed") {
            const message = (event.params.data as { error?: string } | undefined)?.error;
            push({ type: EventType.RUN_ERROR, message: message ?? "Unknown error" });
          }
          break;
        }

        case "input.requested": {
          // The graph hit an interrupt(...) call. Forward as AG-UI
          // CUSTOM `OnInterrupt`, matching the legacy contract so dojo
          // (and other clients) can render the same prompt UI they
          // already drive off the legacy translation.
          const data = event.params?.data as
            | { interrupt_id?: string; payload?: unknown }
            | undefined;
          if (!data) break;
          const value =
            typeof data.payload === "string"
              ? data.payload
              : JSON.stringify(data.payload);
          push({
            type: EventType.CUSTOM,
            name: LangGraphEventTypes.OnInterrupt,
            value,
          } as ProcessedEvents);
          break;
        }

        case "messages": {
          const data = event.params.data as
            | {
                event: string;
                role?: string;
                id?: string;
                index?: number;
                content?: { type?: string };
                delta?: { type?: string; text?: string };
              }
            | undefined;
          if (!data) break;

          switch (data.event) {
            case "message-start": {
              // The protocol declares `role` on MessageStartData but the
              // langgraph dev server omits it in practice. Use any
              // message-start as the signal to bind activeMessageId; the
              // downstream content-block-start filter (type === "text")
              // ensures we only emit text events for AI text blocks.
              if (!data.id) break;
              activeMessageId = data.id;
              break;
            }

            case "content-block-start": {
              if (data.index == null) break;
              const blockType = data.content?.type;
              if (blockType === "text") {
                if (!activeMessageId) break;
                textBlockMessageIds.set(data.index, activeMessageId);
                push({
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: activeMessageId,
                  role: "assistant",
                });
              } else if (blockType === "tool_call_chunk" || blockType === "tool_call") {
                const block = data.content as
                  | { id?: string | null; name?: string | null; args?: string | null }
                  | undefined;
                const toolCallId = block?.id ?? `tc-${data.index}`;
                const toolCallName = block?.name ?? "";
                const initialArgs = typeof block?.args === "string" ? block.args : "";
                toolBlocks.set(data.index, {
                  toolCallId,
                  toolCallName,
                  argsSoFar: initialArgs,
                });
                push({
                  type: EventType.TOOL_CALL_START,
                  toolCallId,
                  toolCallName,
                  parentMessageId: activeMessageId,
                });
                if (initialArgs.length > 0) {
                  push({
                    type: EventType.TOOL_CALL_ARGS,
                    toolCallId,
                    delta: initialArgs,
                  });
                }
              }
              break;
            }

            case "content-block-delta": {
              if (data.index == null) break;
              const deltaType = data.delta?.type;
              if (deltaType === "text-delta") {
                const messageId = textBlockMessageIds.get(data.index);
                if (!messageId) break;
                push({
                  type: EventType.TEXT_MESSAGE_CONTENT,
                  messageId,
                  delta: data.delta?.text ?? "",
                });
              } else if (deltaType === "block-delta") {
                // BlockDelta carries shallow-merge fields. For tool calls
                // `args` is the FULL cumulative JSON string, not an
                // incremental piece. AG-UI's TOOL_CALL_ARGS expects a delta,
                // so compute it by stripping the prefix we have already sent.
                const tool = toolBlocks.get(data.index);
                if (!tool) break;
                const fields = (data.delta as { fields?: { args?: string; name?: string } } | undefined)?.fields;
                if (fields?.name && !tool.toolCallName) {
                  tool.toolCallName = fields.name;
                }
                if (typeof fields?.args === "string") {
                  const cumulative = fields.args;
                  if (cumulative.startsWith(tool.argsSoFar)) {
                    const delta = cumulative.slice(tool.argsSoFar.length);
                    tool.argsSoFar = cumulative;
                    if (delta.length > 0) {
                      push({
                        type: EventType.TOOL_CALL_ARGS,
                        toolCallId: tool.toolCallId,
                        delta,
                      });
                    }
                  } else {
                    // Engine replaced the buffer (e.g. arg correction). Send
                    // the full new string as a single delta and reset the
                    // cumulative tracker.
                    tool.argsSoFar = cumulative;
                    push({
                      type: EventType.TOOL_CALL_ARGS,
                      toolCallId: tool.toolCallId,
                      delta: cumulative,
                    });
                  }
                }
              }
              break;
            }

            case "content-block-finish": {
              if (data.index == null) break;
              const messageId = textBlockMessageIds.get(data.index);
              if (messageId) {
                push({ type: EventType.TEXT_MESSAGE_END, messageId });
                textBlockMessageIds.delete(data.index);
                break;
              }
              const tool = toolBlocks.get(data.index);
              if (tool) {
                push({ type: EventType.TOOL_CALL_END, toolCallId: tool.toolCallId });
                toolBlocks.delete(data.index);
              }
              break;
            }

            case "message-finish": {
              activeMessageId = undefined;
              break;
            }

            case "message-error": {
              activeMessageId = undefined;
              textBlockMessageIds.clear();
              break;
            }
          }
          break;
        }

        case "values": {
          // Cache only — actual snapshot emission happens at root
          // lifecycle.completed. This skips the transient
          // copilotkitMiddleware "intercept then restore" dip where the
          // assistant message briefly loses its tool calls.
          if (!isRootNamespace(event.params.namespace)) break;
          cacheState(event.params.data);
          break;
        }

        case "tasks": {
          // v3 protocol surfaces interrupt() calls as `tasks` events
          // with an `interrupts: [...]` field on the task result —
          // NOT as `input.requested` lifecycle events. The root
          // lifecycle still terminates with `completed`. Scan tasks
          // for interrupt entries and emit AG-UI CUSTOM `OnInterrupt`.
          const data = event.params?.data as
            | {
                id?: string;
                name?: string;
                interrupts?: Array<{ id?: string; value?: unknown }>;
              }
            | undefined;
          if (!data?.interrupts?.length) break;
          for (const it of data.interrupts) {
            if (!it?.id) continue;
            if (emittedInterruptIds.has(it.id)) continue;
            emittedInterruptIds.add(it.id);
            const value =
              typeof it.value === "string"
                ? it.value
                : JSON.stringify(it.value);
            push({
              type: EventType.CUSTOM,
              name: LangGraphEventTypes.OnInterrupt,
              value,
            } as ProcessedEvents);
          }
          break;
        }

        // custom, checkpoints, updates, input — handled in subsequent
        // phases. Drop through.
        default:
          break;
      }

      return true;
    },
  };
};
