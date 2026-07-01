import type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  AgentConfig,
  BaseEvent,
  CustomEvent,
  Interrupt,
  Message,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  RunAgentInput,
  RunFinishedEvent,
  RunFinishedInterruptOutcome,
  RunStartedEvent,
  StateSnapshotEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/client";
import { AbstractAgent, EventType } from "@ag-ui/client";
import type { StorageThreadType } from "@mastra/core/memory";
import type { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { randomUUID } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { MastraClient } from "@mastra/client-js";
import {
  convertAGUIMessagesToMastra,
  GetLocalAgentsOptions,
  getLocalAgents,
  getRemoteAgents,
  GetRemoteAgentsOptions,
  GetLocalAgentOptions,
  getLocalAgent,
  GetNetworkOptions,
  getNetwork,
} from "./utils";

type RemoteMastraAgent = ReturnType<MastraClient["getAgent"]>;

/**
 * AG-UI `activityType` used for Mastra Background Tasks. Background work
 * (a tool with `background: { enabled: true }`) runs out-of-band while the
 * agent conversation continues; the bridge surfaces its lifecycle as AG-UI
 * ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events so the UI can render it distinctly
 * from normal streamed responses. Renderers register against this string via
 * CopilotKit's `renderActivityMessages` prop.
 *
 * The activity `content` shape (one activity per Mastra task; `messageId` is
 * the Mastra `taskId`):
 *
 *   {
 *     taskId: string;        // Mastra background task id (== activity messageId)
 *     toolName: string;      // the backgrounded tool
 *     toolCallId: string;    // originating tool call
 *     status: "started" | "running" | "suspended" | "resumed"
 *           | "completed" | "failed" | "cancelled";
 *     args?: Record<string, unknown>;  // tool args, once running
 *     outputs: unknown[];    // streamed tool-output chunks, appended in order
 *     elapsedMs?: number;    // wall-clock since dispatch, ticked by progress
 *     result?: unknown;      // final result on completion
 *     error?: string;        // message on failure
 *     suspendPayload?: unknown; // data passed to suspend(), when suspended
 *     startedAt?: string;    // ISO timestamp
 *     completedAt?: string;  // ISO timestamp
 *   }
 *
 * This shape is a sensible default proposed by the AG-UI bridge; it is intended
 * to be co-designed with Mastra (see OSS-93) and may evolve.
 */
export const MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE = "mastra-background-task";

// Shape of a remote resume response. Newer @mastra/client-js (>= the release
// that added agent suspend/resume) exposes `resumeStream` on the remote Agent
// resource; it returns a Response augmented with `processDataStream` — the same
// callback-based stream the remote `.stream()` path consumes. We type it
// structurally (not against the installed client-js) so the bridge compiles
// against older client-js builds that predate `resumeStream`; the capability is
// probed at runtime via `hasRemoteResume` before use.
type RemoteResumeResponse = {
  processDataStream?: (args: {
    onChunk: (chunk: any) => void | Promise<void>;
  }) => Promise<void>;
};

interface RemoteResumableAgent {
  resumeStream(
    resumeData: unknown,
    options: Record<string, unknown>,
  ): Promise<RemoteResumeResponse | null | undefined>;
}

export interface MastraAgentConfig extends AgentConfig {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  requestContext?: RequestContext;
  /**
   * Opt into Mastra's `untilIdle` run mode (local agents only). When set, the
   * bridge passes `untilIdle` to `agent.stream(...)`, which subscribes to the
   * background-task manager for the run's memory scope and pipes the task
   * lifecycle chunks (`background-task-running` / `-output` / `-completed` /
   * `-failed` / …) into the SAME `fullStream`, re-entering the agentic loop so
   * the model reacts to the result in the same run. Without it, only
   * `background-task-started` reaches the run stream and completion is
   * delivered out of band. Requires a configured storage backend + a memory
   * scope (Mastra falls through to the default stream otherwise). `true` uses
   * Mastra's default idle timeout; pass `{ maxIdleMs }` to override.
   *
   * CAVEAT (verified against @mastra/core 1.47.0): in practice only
   * `background-task-started` + `-running` reach the piped stream;
   * `background-task-completed` does NOT arrive, so the run idles out without a
   * completion and the activity stays "running". Treat this as the forward-
   * looking hook for when Mastra delivers terminal lifecycle on the stream;
   * leave it OFF until then (its only effect today is an idle hold with no
   * completion payload).
   */
  untilIdle?: boolean | { maxIdleMs?: number };
  /**
   * Terminate interrupted runs with the AG-UI structured outcome
   * `RUN_FINISHED.outcome={ type: "interrupt", interrupts: [...] }`, mapping each
   * Mastra tool suspend to an `Interrupt`.
   *
   * Default **true** (opt-out). The structured outcome is the canonical AG-UI
   * interrupt path; clients on the canonical resume protocol drive resume via
   * `RunAgentInput.resume`, which the bridge consumes here.
   *
   * REQUIRES a CopilotKit client **>= 1.61.2** (the release that reads
   * `outcome:"interrupt"` and resumes via `RunAgentInput.resume`). On older
   * clients (<= 1.61.1, incl. 1.60.1/1.61.0) the client records the structured
   * interrupt but never addresses it on resume, stranding the run with
   * `Thread has N pending interrupt(s) not addressed by resume`. **If you target
   * a client below 1.61.2, set this to `false`** to fall back to the legacy
   * `on_interrupt`-only path. (The bridge can't detect the client version — the
   * CopilotKit client is the consumer app's dependency, not this package's —
   * so the floor is a documented requirement, not an enforced one.)
   *
   * Independent of the legacy `CUSTOM(name="on_interrupt")` event, which is
   * always emitted (backward compat). When on, BOTH the legacy event and the
   * structured outcome are emitted; when off, only the legacy event plus a plain
   * `RUN_FINISHED` — exactly as before this flag existed. Resume itself consumes
   * BOTH the legacy `forwardedProps.command.resume` and the standard
   * `RunAgentInput.resume` channels regardless of this flag.
   */
  emitInterruptOutcome?: boolean;
}

interface MastraAgentStreamOptions {
  /**
   * Called when Mastra announces the persisted message id for the upcoming
   * step (the `start` / `step-start` chunk's `messageId`). The bridge adopts
   * this id for the assistant message it streams, so the id the client sees
   * equals the id Mastra stores. Without this the bridge would mint its own
   * id, and re-sent history on the next turn would not match storage, causing
   * Mastra to persist the assistant message again (duplicate history).
   */
  onMessageId?: (messageId: string) => void;
  onTextPart?: (text: string) => void;
  onReasoningStart?: () => void;
  onReasoningPart?: (text: string) => void;
  onReasoningEnd?: () => void;
  onFinishMessagePart?: () => void;
  /** Emit TOOL_CALL_START. Fired once per tool call, before any args. */
  onToolCallStart?: (streamPart: {
    toolCallId: string;
    toolName: string;
  }) => void;
  /**
   * Emit a TOOL_CALL_ARGS delta. The bridge streams these incrementally as
   * Mastra emits `tool-call-delta` chunks (raw JSON-text fragments), or emits
   * a single full-args delta on the fall-back path (older @mastra/core that
   * only emits the final `tool-call` chunk).
   */
  onToolCallArgs?: (streamPart: {
    toolCallId: string;
    argsTextDelta: string;
  }) => void;
  /** Emit TOOL_CALL_END. Fired once per tool call, after all args. */
  onToolCallEnd?: (streamPart: { toolCallId: string }) => void;
  onToolResultPart?: (streamPart: { toolCallId: string; result: any }) => void;
  onError: (error: Error) => void;
  onRunFinished?: () => Promise<void>;
  onToolSuspended: (payload: {
    toolCallId: string;
    toolName: string;
    suspendPayload: any;
    args: Record<string, any>;
    resumeSchema: string;
    // The runId Mastra associated with the suspended run, taken from the
    // suspend chunk. Mastra keys the suspended workflow snapshot by this id —
    // which is NOT necessarily the AG-UI RunAgentInput.runId — so resume must
    // round-trip THIS value back to `resumeStream({ runId })`. Optional so the
    // bridge can fall back to the AG-UI runId when a chunk omits it.
    runId?: string;
  }) => void;
  /**
   * Emit an ACTIVITY_SNAPSHOT for a background task (full initial content).
   * Called once per task, when the task starts.
   */
  onActivitySnapshot?: (snapshot: {
    messageId: string;
    activityType: string;
    content: Record<string, any>;
  }) => void;
  /**
   * Emit an ACTIVITY_DELTA for a background task (RFC 6902 JSON patch against
   * the prior snapshot/delta content). Called on each subsequent lifecycle
   * chunk (running, output, progress, completed, failed, cancelled, …).
   */
  onActivityDelta?: (delta: {
    messageId: string;
    activityType: string;
    patch: Array<Record<string, any>>;
  }) => void;
}

export class MastraAgent extends AbstractAgent {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  requestContext?: RequestContext;
  untilIdle?: boolean | { maxIdleMs?: number };
  public headers?: Record<string, string>;
  /** See MastraAgentConfig.emitInterruptOutcome. Default true. */
  emitInterruptOutcome: boolean;

  constructor(private config: MastraAgentConfig) {
    const {
      agent,
      resourceId,
      requestContext,
      untilIdle,
      emitInterruptOutcome,
      ...rest
    } = config;
    super(rest);
    this.emitInterruptOutcome = emitInterruptOutcome ?? true;
    this.agent = agent;
    this.resourceId = resourceId;
    this.requestContext = requestContext ?? new RequestContext();
    this.untilIdle = untilIdle;
  }

  public clone() {
    const cloned = new MastraAgent(this.config);
    if (this.headers) {
      cloned.headers = { ...this.headers };
    }
    return cloned;
  }

  /**
   * Forwards `input.context` onto the Mastra RequestContext under "ag-ui", so a
   * tool reads it via `requestContext.get("ag-ui").context`. Called on every
   * entry path (initial stream + both resume paths) so a resumed run forwards
   * its own context instead of reusing the prior turn's.
   */
  private applyInputContext(context: RunAgentInput["context"]): RequestContext {
    this.requestContext ??= new RequestContext();
    this.requestContext.set("ag-ui", { context });
    return this.requestContext;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    // Fallback id used only until Mastra announces the persisted message id on
    // the start / step-start chunk (see onMessageId). Adopting Mastra's id
    // keeps the streamed assistant id equal to the stored id so re-sent history
    // dedupes instead of duplicating. Remote agents / older Mastra streams that
    // omit the start messageId keep using this fallback (and the rotation below).
    let messageId = randomUUID();

    // Tool suspends collected this run, mapped to AG-UI Interrupts. Only
    // populated when emitInterruptOutcome is on; the terminating RUN_FINISHED
    // carries them as a structured `outcome` (see makeRunFinishedEvent). The
    // legacy CUSTOM(on_interrupt) event is emitted regardless (see
    // onToolSuspended).
    const pendingInterrupts: Interrupt[] = [];

    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        const runStartedEvent: RunStartedEvent = {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        };

        subscriber.next(runStartedEvent);

        // CopilotKit passes resume data via forwardedProps.command (convention
        // shared with LangGraph's interrupt bridge). forwardedProps is untyped
        // (any) — the caller is responsible for shape validation.
        let forwardedCommand = input.forwardedProps?.command;

        // Standard AG-UI resume channel: clients on the canonical interrupt path
        // (CopilotKit >= 1.61.2) drive resume through `RunAgentInput.resume`
        // (an array of { interruptId, status, payload }) instead of the legacy
        // `forwardedProps.command`. Mastra fully overrides run(), so the base
        // AbstractAgent reconcile of `input.resume` is bypassed — we consume it
        // here. We normalize the first entry into the same internal command shape
        // the legacy path uses, so a single resume block serves both channels.
        //
        // The Mastra snapshot runId (the resumeStream key) is NOT carried by a
        // ResumeEntry — only `interruptId` round-trips. So we encode the runId
        // into the emitted Interrupt id as `${runId}::${toolCallId}` (see
        // suspendToInterrupt) and decode it back here.
        if (!forwardedCommand?.interruptEvent && Array.isArray(input.resume)) {
          const entry = input.resume.find(
            (r) => r?.status === "resolved" || r?.status === "cancelled",
          );
          if (entry?.interruptId) {
            const sep = entry.interruptId.indexOf("::");
            const runId =
              sep >= 0 ? entry.interruptId.slice(0, sep) : input.runId;
            const toolCallId =
              sep >= 0 ? entry.interruptId.slice(sep + 2) : entry.interruptId;
            forwardedCommand = {
              resume: entry.status === "cancelled" ? false : entry.payload,
              interruptEvent: { toolCallId, runId },
            };
          }
        }

        // resume: false means the user explicitly declined the tool call.
        // Close the run cleanly without calling resumeStream.
        if (
          forwardedCommand?.resume === false &&
          forwardedCommand?.interruptEvent
        ) {
          await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          } as RunFinishedEvent);
          subscriber.complete();
          return;
        }

        if (
          forwardedCommand?.resume != null &&
          forwardedCommand?.interruptEvent
        ) {
          // Safely parse interruptEvent — client-supplied data
          let interruptEvent: any;
          try {
            interruptEvent =
              typeof forwardedCommand.interruptEvent === "string"
                ? JSON.parse(forwardedCommand.interruptEvent)
                : forwardedCommand.interruptEvent;
          } catch (err) {
            subscriber.error(
              new Error("Invalid interruptEvent: malformed JSON", {
                cause: err,
              }),
            );
            return;
          }

          // Validate required fields for resume
          if (!interruptEvent?.toolCallId || !interruptEvent?.runId) {
            subscriber.error(
              new Error("Invalid interruptEvent: missing toolCallId or runId"),
            );
            return;
          }

          // Re-set this run's context so resume forwards it, not the prior turn's.
          const resumeRequestContext = this.applyInputContext(input.context);

          // Resume options are shared verbatim by the local and remote paths.
          // Mastra keys the suspended snapshot by the runId surfaced on the
          // suspend chunk (round-tripped here as interruptEvent.runId), NOT the
          // AG-UI RunAgentInput.runId — passing the latter fails remote resume
          // with "No snapshot found for this workflow run". The remote instance
          // loads that snapshot from configured storage, so `memory` must point
          // at the same thread/resource the suspended run used.
          const resumeOptions: Record<string, unknown> = {
            toolCallId: interruptEvent.toolCallId,
            runId: interruptEvent.runId,
            memory: {
              thread: input.threadId,
              resource: this.resourceId ?? input.threadId,
            },
            requestContext: resumeRequestContext,
          };
          if (this.headers && Object.keys(this.headers).length > 0) {
            resumeOptions.modelSettings = {
              ...((resumeOptions.modelSettings as
                | Record<string, unknown>
                | undefined) ?? {}),
              headers: this.headers,
            };
          }

          const callbacks = this.makeStreamCallbacks(
            subscriber,
            () => messageId,
            (id) => {
              messageId = id;
            },
            input.runId,
            pendingInterrupts,
          );

          // Shared completion: emit a best-effort working-memory snapshot
          // (no-op for remote agents, which have no local memory) then
          // RUN_FINISHED. makeRunFinishedEvent attaches the structured
          // interrupt outcome when emitInterruptOutcome is on (e.g. a chained
          // interrupt in the resumed stream), so the resumed-run tail is
          // identical for local and remote.
          const finishResume = async () => {
            await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
            subscriber.next(
              this.makeRunFinishedEvent(
                input.threadId,
                input.runId,
                pendingInterrupts,
              ),
            );
            subscriber.complete();
          };

          try {
            if (this.isLocalMastraAgent(this.agent)) {
              const response = await this.agent.resumeStream(
                forwardedCommand.resume,
                resumeOptions,
              );

              // Null/invalid response from resumeStream is an error
              if (
                !response ||
                typeof response !== "object" ||
                !response.fullStream
              ) {
                subscriber.error(
                  new Error(
                    "resumeStream returned no valid response (missing fullStream)",
                  ),
                );
                return;
              }

              const hadError = await this.processFullStream(
                response.fullStream,
                {
                  ...callbacks,
                  onError: (error) => {
                    subscriber.error(error);
                  },
                },
              );

              if (!hadError) {
                await finishResume();
              }
            } else {
              // Remote resume round-trips the suspend state + resume command
              // over @mastra/client-js. The remote Agent's resumeStream returns
              // a processDataStream response (callback-based), so we drive it
              // through the same createChunkProcessor used by the remote
              // .stream() path — single source of truth for chunk handling.
              const remoteAgent = this
                .agent as unknown as Partial<RemoteResumableAgent>;
              if (typeof remoteAgent.resumeStream !== "function") {
                subscriber.error(
                  new Error(
                    "Resume from interrupt requires a @mastra/client-js version that supports agent.resumeStream(); please upgrade @mastra/client-js",
                  ),
                );
                return;
              }

              const response = await remoteAgent.resumeStream(
                forwardedCommand.resume,
                resumeOptions,
              );

              if (
                !response ||
                typeof response.processDataStream !== "function"
              ) {
                subscriber.error(
                  new Error(
                    "resumeStream returned no valid response (missing processDataStream)",
                  ),
                );
                return;
              }

              let stopped = false;
              const { handleChunk, flush } = this.createChunkProcessor({
                ...callbacks,
                onError: (error) => {
                  subscriber.error(error);
                },
              });

              await response.processDataStream({
                onChunk: async (chunk: any) => {
                  if (stopped) return;
                  if (handleChunk(chunk)) stopped = true;
                },
              });

              if (!stopped) {
                flush();
                await finishResume();
              }
            }
          } catch (error) {
            subscriber.error(error);
          }
          return;
        }

        // Sync AG-UI input state into Mastra's working memory before streaming
        if (this.isLocalMastraAgent(this.agent)) {
          try {
            const memory = await this.agent.getMemory({
              requestContext: this.requestContext,
            });

            if (memory && input.state && Object.keys(input.state).length > 0) {
              let thread: StorageThreadType | null = await memory.getThreadById(
                {
                  threadId: input.threadId,
                  // Mastra's abstract Memory.getThreadById type is narrower than
                  // its runtime contract — concrete Memory subclasses (and
                  // `AGENT_MEMORY_MISSING_RESOURCE_ID` checks along the thread
                  // lifecycle) expect `resourceId`. We forward it here to stay
                  // consistent with the sibling saveThread call below (which
                  // also normalizes `thread.resourceId`) and the
                  // `emitWorkingMemorySnapshot` call to `getWorkingMemory`, and
                  // to match the rest of the run's memory options (`resource:`
                  // on `.stream()` / `.resumeStream()` in `streamMastraAgent`).
                  // @ts-expect-error upstream type omits resourceId; runtime accepts it
                  resourceId: this.resourceId ?? input.threadId,
                },
              );

              if (!thread) {
                thread = {
                  id: input.threadId,
                  title: "",
                  metadata: {},
                  resourceId: this.resourceId ?? input.threadId,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                };
              }

              let existingMemory: Record<string, any> = {};
              try {
                existingMemory = JSON.parse(
                  (thread.metadata?.workingMemory as string) ?? "{}",
                );
              } catch {
                // Working memory metadata is not valid JSON - start fresh
              }
              const { messages, ...rest } = input.state;
              const workingMemory = JSON.stringify({
                ...existingMemory,
                ...rest,
              });

              await memory.saveThread({
                thread: {
                  ...thread,
                  // Ensure resourceId is always set on the persisted thread.
                  // If storage returned a thread with a stale/missing
                  // resourceId (migrated data, foreign writer, etc.) the
                  // naive `...thread` spread would carry that through and
                  // Mastra's Memory would reject the save with
                  // AGENT_MEMORY_MISSING_RESOURCE_ID. Normalize to the run's
                  // authoritative resourceId, matching the sibling
                  // getThreadById call above.
                  resourceId: this.resourceId ?? input.threadId,
                  metadata: {
                    ...thread.metadata,
                    workingMemory,
                  },
                },
              });
            }
          } catch (error) {
            subscriber.error(error);
            return;
          }
        }

        try {
          const streamCallbacks = this.makeStreamCallbacks(
            subscriber,
            () => messageId,
            (id) => {
              messageId = id;
            },
            input.runId,
            pendingInterrupts,
          );

          await this.streamMastraAgent(input, {
            ...streamCallbacks,
            onError: (error) => {
              subscriber.error(error);
            },
            onRunFinished: async () => {
              await this.emitWorkingMemorySnapshot(subscriber, input.threadId);
              subscriber.next(
                this.makeRunFinishedEvent(
                  input.threadId,
                  input.runId,
                  pendingInterrupts,
                ),
              );
              subscriber.complete();
            },
          });
        } catch (error) {
          subscriber.error(error);
        }
      };

      run().catch((err) => {
        if (subscriber.closed) return;
        subscriber.error(err);
      });

      return () => {};
    });
  }

  isLocalMastraAgent(
    agent: LocalMastraAgent | RemoteMastraAgent,
  ): agent is LocalMastraAgent {
    return "getMemory" in agent;
  }

  /**
   * Maps a Mastra tool suspend to an AG-UI {@link Interrupt}.
   *
   * `id` is the suspended tool call id — the correlation key resume sends back
   * (alongside `runId`) via `resumeStream`. `responseSchema` is the parsed
   * `resumeSchema` (Mastra hands it over as a JSON string). Everything the
   * resume round-trip needs that has no first-class Interrupt field
   * (`toolName`, `suspendPayload`, `args`, the snapshot-keying `runId`) is
   * preserved under `metadata.mastra`, shaped like the legacy on_interrupt
   * value so a standard-path client can reconstruct the resume directive.
   */
  private suspendToInterrupt(
    payload: {
      toolCallId: string;
      toolName: string;
      suspendPayload: any;
      args: Record<string, any>;
      resumeSchema: string;
      runId?: string;
    },
    runId: string,
  ): Interrupt {
    let responseSchema: Record<string, any> | undefined;
    const rawSchema = payload.resumeSchema as unknown;
    if (typeof rawSchema === "string" && rawSchema.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawSchema);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          responseSchema = parsed;
        }
      } catch {
        // resumeSchema is not valid JSON — omit responseSchema; the raw value
        // is still carried in metadata.mastra below.
      }
    } else if (
      rawSchema &&
      typeof rawSchema === "object" &&
      !Array.isArray(rawSchema)
    ) {
      responseSchema = rawSchema as Record<string, any>;
    }

    // Encode the snapshot runId into the interrupt id as `${runId}::${toolCallId}`.
    // A standard-path client (CopilotKit >= 1.61.2) only round-trips `interruptId`
    // in its ResumeEntry — not metadata — so the id is the one channel that can
    // carry the runId resume needs (see the input.resume consumer in run()).
    // `toolCallId` stays its own field for the legacy path and for renderers.
    const snapshotRunId = payload.runId ?? runId;
    return {
      id: `${snapshotRunId}::${payload.toolCallId}`,
      reason: "mastra:tool_suspend",
      toolCallId: payload.toolCallId,
      ...(responseSchema ? { responseSchema } : {}),
      metadata: {
        mastra: {
          type: "mastra_suspend",
          toolName: payload.toolName,
          suspendPayload: payload.suspendPayload,
          args: payload.args,
          resumeSchema: payload.resumeSchema,
          // The id Mastra keys the suspended snapshot by (see onToolSuspended).
          runId: snapshotRunId,
        },
      },
    };
  }

  /**
   * Builds the terminating RUN_FINISHED for a run. When emitInterruptOutcome is
   * on AND the run suspended at least one tool, attaches the structured
   * `outcome: { type: "interrupt", interrupts }`. Otherwise emits a plain
   * RUN_FINISHED — the legacy/default behavior. Mirrors LangGraph's
   * `dispatchInterruptFinish`.
   */
  private makeRunFinishedEvent(
    threadId: string,
    runId: string,
    interrupts: Interrupt[],
  ): RunFinishedEvent {
    const includeOutcome = this.emitInterruptOutcome && interrupts.length > 0;
    return {
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
      ...(includeOutcome
        ? {
            outcome: {
              type: "interrupt",
              interrupts,
            } satisfies RunFinishedInterruptOutcome,
          }
        : {}),
    } as RunFinishedEvent;
  }

  /**
   * Fetches working memory from a local agent and emits a STATE_SNAPSHOT event
   * if valid working memory is available.
   *
   * Best-effort: logs a warning and returns gracefully on failure so callers
   * can proceed with RUN_FINISHED even when the snapshot could not be delivered.
   */
  private async emitWorkingMemorySnapshot(
    subscriber: { next: (event: BaseEvent) => void },
    threadId: string,
  ): Promise<boolean> {
    if (!this.isLocalMastraAgent(this.agent)) return true;
    try {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (memory) {
        const workingMemory = await memory.getWorkingMemory({
          resourceId: this.resourceId ?? threadId,
          threadId,
          memoryConfig: {
            workingMemory: {
              enabled: true,
            },
          },
        });

        if (typeof workingMemory === "string") {
          let snapshot: Record<string, any> | null = null;
          try {
            snapshot = JSON.parse(workingMemory);
          } catch {
            // Working memory is not valid JSON (e.g. markdown template)
            // Wrap it so the client still receives the state
            snapshot = { workingMemory };
          }

          // Skip snapshots containing a JSON Schema definition ($schema) —
          // these are Mastra's working-memory templates, not actual state.
          if (snapshot && !("$schema" in snapshot)) {
            subscriber.next({
              type: EventType.STATE_SNAPSHOT,
              snapshot,
            } as StateSnapshotEvent);
          }
        }
      }
      return true;
    } catch (error) {
      console.warn(
        `[MastraAgent] Failed to emit working memory snapshot for thread ${threadId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Creates the callback set used by processFullStream to emit AG-UI events.
   * messageId is accessed/mutated via getter/setter closures so that when
   * onFinishMessagePart replaces the ID with a new UUID, subsequent callbacks
   * in the same run() invocation see the updated value.
   */
  private makeStreamCallbacks(
    subscriber: { next: (event: BaseEvent) => void },
    getMessageId: () => string,
    setMessageId: (id: string) => void,
    runId: string,
    pendingInterrupts: Interrupt[],
  ): Omit<MastraAgentStreamOptions, "onError" | "onRunFinished"> {
    let reasoningMessageId: string | null = null;
    let isReasoning = false;

    const closeReasoning = () => {
      if (isReasoning && reasoningMessageId) {
        subscriber.next({
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId,
        } as ReasoningMessageEndEvent);
        subscriber.next({
          type: EventType.REASONING_END,
          messageId: reasoningMessageId,
        } as ReasoningEndEvent);
        isReasoning = false;
        reasoningMessageId = null;
      }
    };

    const openReasoning = () => {
      if (!isReasoning) {
        reasoningMessageId = randomUUID();
        isReasoning = true;
        subscriber.next({
          type: EventType.REASONING_START,
          messageId: reasoningMessageId,
        } as ReasoningStartEvent);
        subscriber.next({
          type: EventType.REASONING_MESSAGE_START,
          messageId: reasoningMessageId,
          role: "reasoning",
        } as ReasoningMessageStartEvent);
      }
    };

    return {
      onMessageId: (id) => {
        setMessageId(id);
      },
      onReasoningStart: () => {
        openReasoning();
      },
      onReasoningPart: (text) => {
        openReasoning();
        subscriber.next({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: reasoningMessageId!,
          delta: text,
        } as ReasoningMessageContentEvent);
      },
      onReasoningEnd: () => {
        closeReasoning();
      },
      onTextPart: (text) => {
        closeReasoning();
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          role: "assistant",
          messageId: getMessageId(),
          delta: text,
        } as TextMessageChunkEvent);
      },
      onToolCallStart: (streamPart) => {
        closeReasoning();
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          parentMessageId: getMessageId(),
          toolCallId: streamPart.toolCallId,
          toolCallName: streamPart.toolName,
        } as ToolCallStartEvent);
      },
      onToolCallArgs: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: streamPart.toolCallId,
          delta: streamPart.argsTextDelta,
        } as ToolCallArgsEvent);
      },
      onToolCallEnd: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_END,
          toolCallId: streamPart.toolCallId,
        } as ToolCallEndEvent);
      },
      onToolResultPart: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: streamPart.toolCallId,
          content: JSON.stringify(streamPart.result),
          messageId: randomUUID(),
          role: "tool",
        } as ToolCallResultEvent);
      },
      onToolSuspended: (payload) => {
        // Legacy path: always emitted (backward compat, owner decision). The
        // wrapper stays even when emitInterruptOutcome is on.
        subscriber.next({
          type: EventType.CUSTOM,
          name: "on_interrupt",
          value: JSON.stringify({
            type: "mastra_suspend",
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            suspendPayload: payload.suspendPayload,
            args: payload.args,
            resumeSchema: payload.resumeSchema,
            // Prefer the runId Mastra reported on the suspend chunk (the id its
            // snapshot is keyed by); fall back to the AG-UI run's id when the
            // chunk omits one. The resume path round-trips this exact value.
            runId: payload.runId ?? runId,
          }),
        } as CustomEvent);

        // Standard path (opt-in): accumulate the suspend as an AG-UI Interrupt
        // so the terminating RUN_FINISHED carries the structured outcome. Kept
        // separate from the legacy event above — both fire when the flag is on.
        if (this.emitInterruptOutcome) {
          pendingInterrupts.push(this.suspendToInterrupt(payload, runId));
        }
      },
      onFinishMessagePart: () => {
        closeReasoning();
        setMessageId(randomUUID());
      },
      onActivitySnapshot: ({ messageId, activityType, content }) => {
        subscriber.next({
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId,
          activityType,
          content,
        } as ActivitySnapshotEvent);
      },
      onActivityDelta: ({ messageId, activityType, patch }) => {
        subscriber.next({
          type: EventType.ACTIVITY_DELTA,
          messageId,
          activityType,
          patch,
        } as ActivityDeltaEvent);
      },
    };
  }

  /**
   * Creates a stateful chunk processor that maps Mastra stream chunks to
   * AG-UI events via callbacks.
   *
   * Tool-call args are streamed incrementally: Mastra emits
   * `tool-call-input-streaming-start` → one or more `tool-call-delta` (each a
   * raw JSON-text fragment) → `tool-call-input-streaming-end` → a final
   * `tool-call` (with the assembled args) as the model produces the call.
   * When those delta chunks are present we emit TOOL_CALL_START on the start
   * chunk, a TOOL_CALL_ARGS per delta, and TOOL_CALL_END on the end chunk —
   * so the client renders args as they arrive. The trailing `tool-call` for an
   * already-streamed id is a no-op (args were already emitted).
   *
   * Fall-back (backwards compatibility): older @mastra/core in the supported
   * 1.0.x floor may emit only the final `tool-call` with no delta chunks. In
   * that case we buffer the `tool-call` and emit a single START + full-args
   * ARGS + END when it flushes. This buffered path also preserves the
   * suspend protocol: if a buffered tool-call is followed by
   * tool-call-suspended, the TOOL_CALL_* events are suppressed (the tool
   * hasn't executed yet — emitting them confuses CopilotKit's orchestration
   * which expects a TOOL_CALL_RESULT to follow). Suspendable tools are
   * server-side and travel the buffered path; client/generative tools (which
   * never suspend) are the ones whose args stream incrementally.
   *
   * Used by both the local agent path (async iterable) and the remote agent
   * path (processDataStream callback) — single source of truth for chunk
   * handling and buffering logic.
   *
   * @returns An object with two methods:
   *   - `handleChunk`: processes a single chunk; returns `true` if processing should stop (error or malformed chunk).
   *   - `flush`: emits any buffered tool-call (call at end of stream).
   */
  private createChunkProcessor(
    callbacks: MastraAgentStreamOptions,
    clientToolNames: Set<string> = new Set(),
  ) {
    // Only CLIENT (frontend) tools stream their args live — they are the
    // generative-UI tools that benefit from progressive rendering, and they
    // never suspend or background. SERVER tools take the buffered path below so
    // a following `tool-call-suspended` / `background-task-started` can still
    // suppress the normal render (you cannot retract an already-emitted live
    // arg stream). The bridge knows which tools are client tools because they
    // arrive in `RunAgentInput.tools` (→ `clientTools`); server tools live on
    // the Mastra agent and are absent from that set.
    const isClientTool = (toolName?: string) =>
      !!toolName && clientToolNames.has(toolName);

    // Floor / fall-back path: a final `tool-call` with no preceding client
    // delta stream is buffered here so a following tool-call-suspended /
    // background-task-started can suppress it (and reuse its args). Tool calls
    // that streamed deltas live are NOT buffered.
    let pendingToolCall: {
      toolCallId: string;
      toolName: string;
      args: any;
    } | null = null;
    // Tool calls for which we have emitted TOOL_CALL_START via the streaming
    // (delta) path, and (separately) for which we have emitted TOOL_CALL_END.
    const streamedStarted = new Set<string>();
    const streamedEnded = new Set<string>();

    const startStreamedToolCall = (toolCallId: string, toolName: string) => {
      if (!streamedStarted.has(toolCallId)) {
        streamedStarted.add(toolCallId);
        callbacks.onToolCallStart?.({ toolCallId, toolName });
      }
    };

    const endStreamedToolCall = (toolCallId: string) => {
      if (streamedStarted.has(toolCallId) && !streamedEnded.has(toolCallId)) {
        streamedEnded.add(toolCallId);
        callbacks.onToolCallEnd?.({ toolCallId });
      }
    };

    const flush = () => {
      if (pendingToolCall) {
        const { toolCallId, toolName, args } = pendingToolCall;
        pendingToolCall = null;
        callbacks.onToolCallStart?.({ toolCallId, toolName });
        callbacks.onToolCallArgs?.({
          toolCallId,
          // The buffered path has the assembled args object — serialize the
          // whole thing as a single delta (the streaming path emits the raw
          // JSON-text fragments instead).
          argsTextDelta: JSON.stringify(args ?? {}),
        });
        callbacks.onToolCallEnd?.({ toolCallId });
      }
    };

    // taskIds for which an ACTIVITY_SNAPSHOT has already been emitted. Guards
    // against emitting a delta before its snapshot and bounds progress ticks to
    // tasks the client knows about.
    const knownTasks = new Set<string>();

    // Maps an in-flight background tool call (by toolCallId) to its task, so we
    // can correlate the loop's inline `tool-result` / `tool-error` back to the
    // activity. When a backgrounded tool finishes within the agent loop's wait
    // window, Mastra surfaces only `background-task-started` on the main stream
    // and delivers the outcome as an ordinary `tool-result` — there is no
    // `background-task-completed` here (that lives on the manager's own stream).
    const backgroundToolCalls = new Map<
      string,
      { taskId: string; toolName?: string }
    >();

    const toISO = (value: unknown): unknown =>
      value instanceof Date ? value.toISOString() : value;

    // Seed an activity for a task if we haven't already (defensive: a running /
    // output chunk should always follow a started chunk, but a delta with no
    // prior snapshot would be unrenderable).
    const ensureTaskSnapshot = (payload: any) => {
      const { taskId, toolName, toolCallId, args } = payload ?? {};
      if (!taskId || knownTasks.has(taskId)) return;
      knownTasks.add(taskId);
      const content: Record<string, any> = {
        taskId,
        toolName,
        toolCallId,
        // The task is dispatched and executing out of band; surface it as
        // "running" so the UI reads as active immediately (the inline path
        // never emits a separate running delta).
        status: "running",
        outputs: [],
      };
      if (args !== undefined) content.args = args;
      callbacks.onActivitySnapshot?.({
        messageId: taskId,
        activityType: MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE,
        content,
      });
    };

    const emitTaskDelta = (
      taskId: string,
      patch: Array<Record<string, any>>,
    ) => {
      if (!taskId || patch.length === 0) return;
      callbacks.onActivityDelta?.({
        messageId: taskId,
        activityType: MASTRA_BACKGROUND_TASK_ACTIVITY_TYPE,
        patch,
      });
    };

    const handleChunk = (chunk: any): boolean => {
      // Chunks without a `payload` are not fatal. Mastra 1.31+ emits
      // custom-data chunks (e.g. `data-*` types via context.writer.custom)
      // that carry `data` instead of `payload`, plus new lifecycle chunk
      // types this switch doesn't recognize. Skip them gracefully (warn,
      // return false) so the rest of the stream — including RUN_FINISHED —
      // still flows, rather than aborting the run.
      if (!chunk || !chunk.payload) {
        console.warn(
          `[MastraAgent] Skipping stream chunk without payload: type=${chunk?.type ?? "undefined"}`,
        );
        return false;
      }
      switch (chunk.type) {
        case "reasoning-start": {
          callbacks.onReasoningStart?.();
          break;
        }
        case "reasoning-delta": {
          callbacks.onReasoningPart?.(chunk.payload.text);
          break;
        }
        case "reasoning-end": {
          callbacks.onReasoningEnd?.();
          break;
        }
        case "reasoning-signature":
        case "redacted-reasoning":
          break;
        case "text-delta": {
          flush();
          callbacks.onTextPart?.(chunk.payload.text);
          break;
        }
        // Tool-call args stream incrementally: start → delta(s) → end → the
        // final `tool-call`. For CLIENT tools we emit these live (progressive
        // render). For SERVER tools we ignore the delta chunks and buffer the
        // final `tool-call` (below) so it stays suppressible.
        case "tool-call-input-streaming-start": {
          // A new tool call begins — flush any prior buffered (floor-path) call.
          flush();
          if (
            chunk.payload.toolCallId &&
            isClientTool(chunk.payload.toolName)
          ) {
            startStreamedToolCall(
              chunk.payload.toolCallId,
              chunk.payload.toolName,
            );
          }
          break;
        }
        case "tool-call-delta": {
          const { toolCallId, argsTextDelta } = chunk.payload;
          // Only forward deltas for a call we opened as a live (client) stream.
          // Server-tool deltas are ignored; their args ride the final
          // `tool-call` chunk into the buffered path.
          if (
            toolCallId &&
            streamedStarted.has(toolCallId) &&
            argsTextDelta != null
          ) {
            callbacks.onToolCallArgs?.({ toolCallId, argsTextDelta });
          }
          break;
        }
        case "tool-call-input-streaming-end": {
          if (chunk.payload.toolCallId) {
            endStreamedToolCall(chunk.payload.toolCallId);
          }
          break;
        }
        case "tool-call": {
          const { toolCallId, toolName, args } = chunk.payload;
          if (toolCallId && streamedStarted.has(toolCallId)) {
            // Client tool: args were already streamed live via deltas — close
            // the call (the streaming-end chunk may have been absent) and don't
            // re-emit.
            endStreamedToolCall(toolCallId);
            break;
          }
          // Server tool (or a client tool that emitted no deltas): buffer so a
          // following tool-call-suspended / background-task-started can suppress
          // it and reuse its args, matching the pre-streaming behavior.
          flush();
          pendingToolCall = { toolCallId, toolName, args };
          break;
        }
        case "tool-result": {
          // For a backgrounded call, the agent loop's inline tool-result is a
          // placeholder ack ("…running in the background; you will be notified
          // when it completes"), NOT the real outcome — the task is detached
          // and its true result is delivered out of band (a later turn / the
          // manager's own stream). So suppress it: don't render a TOOL_CALL_
          // RESULT for a tool call we never rendered, and leave the activity in
          // its "running" state. Real completion arrives via the
          // background-task-completed / -failed chunks handled below.
          if (backgroundToolCalls.has(chunk.payload.toolCallId)) {
            backgroundToolCalls.delete(chunk.payload.toolCallId);
            break;
          }
          flush();
          callbacks.onToolResultPart?.({
            toolCallId: chunk.payload.toolCallId,
            result: chunk.payload.result,
          });
          break;
        }
        case "tool-error": {
          // An inline error on a backgrounded call means dispatch itself failed
          // -> mark the activity failed. Non-background tool errors fall through
          // to the stream's `error` handling elsewhere, so just swallow here.
          const bgError = backgroundToolCalls.get(chunk.payload?.toolCallId);
          if (bgError) {
            backgroundToolCalls.delete(chunk.payload.toolCallId);
            knownTasks.delete(bgError.taskId);
            emitTaskDelta(bgError.taskId, [
              { op: "add", path: "/status", value: "failed" },
              {
                op: "add",
                path: "/error",
                value:
                  chunk.payload?.error?.message ??
                  String(chunk.payload?.error ?? "Unknown error"),
              },
            ]);
          }
          break;
        }
        case "error": {
          const error = new Error(chunk.payload.error as string);
          callbacks.onError(error);
          return true;
        }
        case "tool-call-suspended": {
          // Always discard the pending tool-call: if it matches, the tool
          // was suspended before execution; if it doesn't match, the pending
          // call is orphaned (never executed) so emitting TOOL_CALL_START/
          // ARGS/END without a TOOL_CALL_RESULT would violate the protocol.
          pendingToolCall = null;
          if (!chunk.payload.toolCallId || !chunk.payload.toolName) {
            callbacks.onError(
              new Error(
                `Malformed tool-call-suspended: missing toolCallId or toolName in payload`,
              ),
            );
            return true;
          }
          callbacks.onToolSuspended({
            toolCallId: chunk.payload.toolCallId,
            toolName: chunk.payload.toolName,
            suspendPayload: chunk.payload.suspendPayload,
            args: chunk.payload.args,
            resumeSchema: chunk.payload.resumeSchema,
            // Mastra keys the suspended snapshot by the run's id, surfaced on
            // the chunk (`payload.runId`, else the chunk-level `runId`). This
            // can differ from the AG-UI RunAgentInput.runId, so it must be the
            // id resume sends back to `resumeStream`. See the resume path.
            runId: chunk.payload.runId ?? chunk.runId,
          });
          break;
        }
        // Both "finish" and "step-finish" flush any pending tool call and rotate
        // the messageId so the next step's text gets a fresh ID. When a stream
        // ends with step-finish followed by finish, onFinishMessagePart fires
        // twice — the second rotation produces an unused messageId, which is harmless.
        case "finish":
        case "step-finish": {
          flush();
          callbacks.onFinishMessagePart?.();
          break;
        }
        // Mastra announces the persisted message id for the upcoming step on
        // the start / step-start chunk, before any text streams. Adopt it so
        // the streamed assistant id equals the stored id (see onMessageId).
        case "start":
        case "step-start": {
          if (chunk.payload?.messageId) {
            callbacks.onMessageId?.(chunk.payload.messageId);
          }
          break;
        }
        // --- Background Tasks (@mastra/core >= 1.29) ---------------------
        // Mastra runs a tool flagged `background: { enabled: true }` out of
        // band; its lifecycle surfaces on fullStream as background-task-*
        // chunks. Map start -> ACTIVITY_SNAPSHOT (full content) and every
        // subsequent lifecycle chunk -> ACTIVITY_DELTA (JSON patch). The task
        // id round-trips as the activity messageId so all events for one task
        // address the same activity message. JSON-patch `add` to an existing
        // object member replaces it (RFC 6902 §4.1), so it is safe for both
        // first-write and updates.
        case "background-task-started": {
          const { taskId, toolName, toolCallId } = chunk.payload;
          // The agent loop emits `tool-call` immediately before this; the
          // bridge has it buffered in pendingToolCall. Suppress that normal
          // tool render (the work is now an activity) but reuse its args for
          // the snapshot. Mirrors the tool-call-suspended suppression.
          const args =
            pendingToolCall && pendingToolCall.toolCallId === toolCallId
              ? pendingToolCall.args
              : undefined;
          pendingToolCall = null;
          if (taskId && toolCallId) {
            backgroundToolCalls.set(toolCallId, { taskId, toolName });
          }
          ensureTaskSnapshot({ taskId, toolName, toolCallId, args });
          break;
        }
        case "background-task-running":
        case "background-task-resumed": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          const status =
            chunk.type === "background-task-resumed" ? "resumed" : "running";
          const patch: Array<Record<string, any>> = [
            { op: "add", path: "/status", value: status },
          ];
          if (p.args !== undefined)
            patch.push({ op: "add", path: "/args", value: p.args });
          if (p.startedAt !== undefined)
            patch.push({
              op: "add",
              path: "/startedAt",
              value: toISO(p.startedAt),
            });
          emitTaskDelta(p.taskId, patch);
          break;
        }
        case "background-task-output": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          // p.payload is a `tool-output` chunk; surface its inner payload (the
          // actual streamed output) and fall back to the whole chunk.
          const output = p.payload?.payload ?? p.payload;
          emitTaskDelta(p.taskId, [
            { op: "add", path: "/status", value: "running" },
            { op: "add", path: "/outputs/-", value: output },
          ]);
          break;
        }
        case "background-task-progress": {
          // Aggregate heartbeat across all running tasks (no per-task id).
          // Tick the elapsed time on each task the client already knows about.
          const p = chunk.payload;
          const taskIds: string[] = Array.isArray(p.taskIds) ? p.taskIds : [];
          for (const taskId of taskIds) {
            if (!knownTasks.has(taskId)) continue;
            emitTaskDelta(taskId, [
              { op: "add", path: "/elapsedMs", value: p.elapsedMs },
            ]);
          }
          break;
        }
        case "background-task-suspended": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          const patch: Array<Record<string, any>> = [
            { op: "add", path: "/status", value: "suspended" },
          ];
          if (p.suspendPayload !== undefined)
            patch.push({
              op: "add",
              path: "/suspendPayload",
              value: p.suspendPayload,
            });
          emitTaskDelta(p.taskId, patch);
          break;
        }
        case "background-task-completed": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          knownTasks.delete(p.taskId);
          backgroundToolCalls.delete(p.toolCallId);
          emitTaskDelta(p.taskId, [
            {
              op: "add",
              path: "/status",
              value: p.isError ? "failed" : "completed",
            },
            { op: "add", path: "/result", value: p.result },
            { op: "add", path: "/completedAt", value: toISO(p.completedAt) },
          ]);
          break;
        }
        case "background-task-failed": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          knownTasks.delete(p.taskId);
          backgroundToolCalls.delete(p.toolCallId);
          emitTaskDelta(p.taskId, [
            { op: "add", path: "/status", value: "failed" },
            {
              op: "add",
              path: "/error",
              value: p.error?.message ?? String(p.error ?? "Unknown error"),
            },
            { op: "add", path: "/completedAt", value: toISO(p.completedAt) },
          ]);
          break;
        }
        case "background-task-cancelled": {
          const p = chunk.payload;
          ensureTaskSnapshot(p);
          knownTasks.delete(p.taskId);
          backgroundToolCalls.delete(p.toolCallId);
          emitTaskDelta(p.taskId, [
            { op: "add", path: "/status", value: "cancelled" },
            { op: "add", path: "/completedAt", value: toISO(p.completedAt) },
          ]);
          break;
        }
        default: {
          console.warn(
            `[MastraAgent] Unrecognized stream chunk type: ${chunk.type}`,
          );
          break;
        }
      }
      return false;
    };

    return { handleChunk, flush };
  }

  /**
   * Processes a Mastra fullStream (async iterable) using createChunkProcessor.
   * @returns true if processing stopped early (error chunk or malformed chunk).
   */
  private async processFullStream(
    stream: AsyncIterable<any>,
    callbacks: MastraAgentStreamOptions,
    clientToolNames: Set<string> = new Set(),
  ): Promise<boolean> {
    const { handleChunk, flush } = this.createChunkProcessor(
      callbacks,
      clientToolNames,
    );
    for await (const chunk of stream) {
      if (handleChunk(chunk)) return true;
    }
    flush();
    return false;
  }

  /**
   * Returns only the messages Mastra has not already persisted for this thread
   * — the new turn — so we don't re-feed (and re-persist) history Mastra memory
   * already owns. Filters the incoming list against the ids Mastra has stored
   * (recall), mirroring LangGraph's continuation check.
   *
   * Faithful because the bridge streams assistant messages under Mastra's
   * stored id (see onMessageId), so re-sent history matches stored ids and is
   * dropped. Remote agents and agents without memory get the full list (no
   * stored history to dedupe against). Defensive: if filtering would drop
   * everything, or recall fails, forwards the full list.
   */
  private async selectNewMessages(
    threadId: string,
    resourceId: string,
    messages: Message[],
  ): Promise<Message[]> {
    if (!this.isLocalMastraAgent(this.agent)) return messages;
    try {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (!memory) return messages;
      const { messages: stored } = await memory.recall({
        threadId,
        resourceId,
        perPage: false,
      });
      const storedIds = new Set(
        (stored ?? []).map((m: { id?: string }) => m.id).filter(Boolean),
      );
      if (storedIds.size === 0) return messages; // first turn / empty thread
      const fresh = messages.filter((m) => !(m.id && storedIds.has(m.id)));
      // Never send an empty turn (a no-op run). If everything was already
      // stored, fall back to forwarding the full list.
      if (fresh.length === 0) return messages;

      // Tool-result tails: a `tool` message must travel with its matching
      // assistant tool-call so the AI SDK resolves call→result into a single
      // message. That assistant message is usually already stored (filtered out
      // above), so re-include it — id-alignment makes Mastra upsert it by id, so
      // no extra row is created. Without this, a lone tool-result leaves the
      // stored call unresolved: Mastra appends a separate result message (a
      // call/result split) and the model re-calls the tool.
      const freshSet = new Set(fresh);
      const neededToolCallIds = new Set(
        fresh
          .filter((m) => m.role === "tool")
          .map((m) => (m as { toolCallId?: string }).toolCallId)
          .filter(Boolean),
      );
      if (neededToolCallIds.size === 0) return fresh;
      const pairedCalls = messages.filter(
        (m) =>
          !freshSet.has(m) &&
          m.role === "assistant" &&
          (m.toolCalls ?? []).some((tc) => neededToolCallIds.has(tc.id)),
      );
      if (pairedCalls.length === 0) return fresh;
      // Preserve original order so each tool-call precedes its result.
      const keep = new Set([...fresh, ...pairedCalls]);
      return messages.filter((m) => keep.has(m));
    } catch (error) {
      console.warn(
        `[MastraAgent] Failed to compute new-message diff for thread ${threadId}; sending full history:`,
        error,
      );
      return messages;
    }
  }

  /**
   * Streams a local or remote Mastra agent, emitting AG-UI events via callbacks.
   * For local agents, iterates fullStream with processFullStream.
   * For remote agents, uses processDataStream with createChunkProcessor.
   * Calls onRunFinished on success. For errors, onError is called either from
   * within stream processing (error chunks) or from the catch block (thrown exceptions).
   */
  private async streamMastraAgent(
    { threadId, runId, messages, tools, context: inputContext }: RunAgentInput,
    {
      onMessageId,
      onTextPart,
      onReasoningStart,
      onReasoningPart,
      onReasoningEnd,
      onFinishMessagePart,
      onToolCallStart,
      onToolCallArgs,
      onToolCallEnd,
      onToolResultPart,
      onToolSuspended,
      onActivitySnapshot,
      onActivityDelta,
      onError,
      onRunFinished,
    }: MastraAgentStreamOptions,
  ): Promise<void> {
    const clientTools = tools.reduce(
      (acc, tool) => {
        acc[tool.name as string] = {
          id: tool.name,
          description: tool.description,
          inputSchema: tool.parameters,
        };
        return acc;
      },
      {} as Record<string, any>,
    );
    // Names of the frontend tools — only these stream their args live (see
    // createChunkProcessor). Server tools (on the Mastra agent) are absent here.
    const clientToolNames = new Set<string>(
      tools.map((tool) => tool.name as string),
    );
    const resourceId = this.resourceId ?? threadId;

    // AG-UI clients (e.g. CopilotKit) re-send the entire conversation every
    // turn. Mastra memory already owns the thread history, so forwarding the
    // full history re-persists it and balloons storage. Instead we send only
    // the *new* messages: messages whose id Mastra has not already stored.
    // This mirrors LangGraph's continuation check (filter incoming against the
    // checkpoint's message ids) and is faithful because the bridge streams
    // assistant messages under Mastra's stored id (see onMessageId), so re-sent
    // history matches and is filtered out. Mastra still loads full history from
    // memory on read, so the model sees the complete conversation.
    const messagesToSend = await this.selectNewMessages(
      threadId,
      resourceId,
      messages,
    );
    // Convert only the new turn, but resolve tool-message names against the
    // full incoming history (the assistant tool-call may have been filtered
    // out of messagesToSend).
    const convertedMessages = convertAGUIMessagesToMastra(
      messagesToSend,
      messages,
    );
    const requestContext = this.applyInputContext(inputContext);

    if (this.isLocalMastraAgent(this.agent)) {
      try {
        const streamOptions: Record<string, unknown> = {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          runId,
          clientTools,
          requestContext,
        };
        // Pipe the background-task lifecycle into this run's fullStream (and
        // re-enter the loop on completion) when opted in. Only meaningful for
        // local agents with storage + a memory scope; Mastra falls through to
        // the default stream otherwise.
        if (this.untilIdle) {
          streamOptions.untilIdle = this.untilIdle;
        }
        if (this.headers && Object.keys(this.headers).length > 0) {
          streamOptions.modelSettings = {
            ...((streamOptions.modelSettings as
              | Record<string, unknown>
              | undefined) ?? {}),
            headers: this.headers,
          };
        }
        const response = await this.agent.stream(
          convertedMessages,
          streamOptions,
        );

        if (response && typeof response === "object") {
          const hadError = await this.processFullStream(
            response.fullStream,
            {
              onMessageId,
              onTextPart,
              onReasoningStart,
              onReasoningPart,
              onReasoningEnd,
              onFinishMessagePart,
              onToolCallStart,
              onToolCallArgs,
              onToolCallEnd,
              onToolResultPart,
              onToolSuspended,
              onActivitySnapshot,
              onActivityDelta,
              onError,
            },
            clientToolNames,
          );

          if (!hadError) await onRunFinished?.();
        } else {
          throw new Error("Invalid response from local agent");
        }
      } catch (error) {
        onError(error as Error);
      }
    } else {
      let stopped = false;
      try {
        const streamOptions: Record<string, unknown> = {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          runId,
          clientTools,
          requestContext,
        };
        if (this.headers && Object.keys(this.headers).length > 0) {
          streamOptions.modelSettings = {
            ...((streamOptions.modelSettings as
              | Record<string, unknown>
              | undefined) ?? {}),
            headers: this.headers,
          };
        }
        const response = await this.agent.stream(
          convertedMessages,
          streamOptions,
        );

        // Remote agents use processDataStream (callback-based) — share
        // chunk handling logic via createChunkProcessor.
        if (response && typeof response.processDataStream === "function") {
          const { handleChunk, flush } = this.createChunkProcessor(
            {
              onMessageId,
              onTextPart,
              onReasoningStart,
              onReasoningPart,
              onReasoningEnd,
              onFinishMessagePart,
              onToolCallStart,
              onToolCallArgs,
              onToolCallEnd,
              onToolResultPart,
              onToolSuspended,
              onActivitySnapshot,
              onActivityDelta,
              onError,
            },
            clientToolNames,
          );

          await response.processDataStream({
            onChunk: async (chunk: any) => {
              if (stopped) return;
              if (handleChunk(chunk)) stopped = true;
            },
          });
          if (!stopped) flush();
          if (!stopped) await onRunFinished?.();
        } else {
          throw new Error("Invalid response from remote agent");
        }
      } catch (error) {
        if (!stopped) onError(error as Error);
      }
    }
  }

  static async getRemoteAgents(
    options: GetRemoteAgentsOptions,
  ): Promise<Record<string, AbstractAgent>> {
    return getRemoteAgents(options);
  }

  static getLocalAgents(
    options: GetLocalAgentsOptions,
  ): Record<string, AbstractAgent> {
    return getLocalAgents(options);
  }

  static getLocalAgent(options: GetLocalAgentOptions) {
    return getLocalAgent(options);
  }

  static getNetwork(options: GetNetworkOptions) {
    return getNetwork(options);
  }
}
