import type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  AgentCapabilities,
  AgentConfig,
  BaseEvent,
  Interrupt,
  Message,
  ReasoningEncryptedValueEvent,
  ReasoningStartEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningEndEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunFinishedOutcome,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/client";
import { AbstractAgent, EventType, PROTOCOL_VERSION } from "@ag-ui/client";
import { TokenUsage, tokenUsageFromAiSdkUsage } from "@ag-ui/core";
import type { Agent as LocalMastraAgent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import { randomUUID } from "@ag-ui/client";
import jsonpatch from "fast-json-patch";
import { parsePartialJson } from "@ai-sdk/ui-utils";
import { Observable, type Subscriber } from "rxjs";
import { MastraClient } from "@mastra/client-js";
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
import { planA2UIInjection, type A2UIInjectConfig } from "./a2ui-tool";
import {
  type ReasoningArtifact,
  encodeReasoningArtifact,
  isEmptyReasoningArtifact,
  mergeReasoningArtifact,
  readReasoningArtifact,
} from "./encrypted-reasoning";
import { readModelOutput, toolResultContent } from "./tool-results";

const { compare } = jsonpatch;

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

/**
 * Tool name(s) Mastra uses for the built-in working-memory update tool. When an
 * agent has working memory enabled, Mastra injects this tool; the model calls
 * it mid-run with the new working-memory content. The bridge maps those calls
 * to AG-UI STATE_DELTA (see createChunkProcessor). Mastra registers it under
 * the key `updateWorkingMemory` (the name that appears on the stream chunk;
 * `UPDATE_WORKING_MEMORY_TOOL_NAME` in @mastra/core) with tool id
 * `update-working-memory` — match both so the mapping is robust to either.
 */
const WORKING_MEMORY_TOOL_NAMES = new Set([
  "updateWorkingMemory",
  "update-working-memory",
]);

// Chunk types the chunk processor handles without emitting anything.
const SILENT_CHUNK_TYPES = new Set([
  "text-start",
  "text-end",
  "tool-output",
  "abort",
]);

// Observational Memory chunk types surfaced as activity (see handleOmChunk);
// every other data-om-* chunk is swallowed.
const SURFACED_OM_CHUNK_TYPES = new Set([
  "data-om-observation-start",
  "data-om-buffering-start",
  "data-om-observation-end",
  "data-om-buffering-end",
  "data-om-observation-failed",
  "data-om-buffering-failed",
  "data-om-activation",
]);

// Chunk types that can carry the turn's native message id.
const MESSAGE_ID_CHUNK_TYPES = new Set([
  "start",
  "step-start",
  "step-finish",
  "finish",
]);

/**
 * Deep-merges a working-memory update onto the existing state, mirroring
 * @mastra/core's `deepMergeWorkingMemory` (the semantics schema/json working
 * memory applies to partial updates): nested objects recurse, arrays are
 * replaced wholesale, an explicit `null` deletes the key, scalars overwrite.
 * Replicated here so the bridge can compute the post-update state — and thus an
 * accurate RFC-6902 delta — synchronously, without a mid-stream memory re-read.
 */
function deepMergeWorkingMemory(
  existing: Record<string, any> | undefined,
  update: Record<string, any>,
): Record<string, any> {
  if (
    !update ||
    typeof update !== "object" ||
    Object.keys(update).length === 0
  ) {
    return existing && typeof existing === "object" ? { ...existing } : {};
  }
  if (!existing || typeof existing !== "object") {
    return update;
  }
  const result: Record<string, any> = { ...existing };
  for (const key of Object.keys(update)) {
    const updateValue = update[key];
    const existingValue = result[key];
    if (updateValue === null) {
      delete result[key];
    } else if (Array.isArray(updateValue)) {
      result[key] = updateValue;
    } else if (
      typeof updateValue === "object" &&
      updateValue !== null &&
      typeof existingValue === "object" &&
      existingValue !== null &&
      !Array.isArray(existingValue)
    ) {
      result[key] = deepMergeWorkingMemory(existingValue, updateValue);
    } else {
      result[key] = updateValue;
    }
  }
  return result;
}

/**
 * Parses the `memory` argument of an `updateWorkingMemory` tool call into a
 * plain object suitable for structured state diffing. The arg is a JSON string
 * for schema/json working memory (the state-rendering case). Returns `undefined`
 * for markdown-template working memory (non-JSON string) or any non-object
 * payload — the caller then skips STATE_DELTA and relies on the run-end
 * STATE_SNAPSHOT.
 */
function parseWorkingMemoryUpdate(
  args: Record<string, any> | undefined,
): Record<string, any> | undefined {
  const raw = args?.memory ?? args;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  return undefined;
}

/**
 * Best-effort parse of the PARTIAL, still-streaming raw tool-input text of an
 * `updateWorkingMemory` call — the accumulated `tool-call-delta` fragments, e.g.
 * `{"memory":"{\"recipe\":{\"title\":\"Sp`. Uses `parsePartialJson` (repairs
 * truncated JSON) twice: once for the outer `{ memory }` envelope, then for the
 * inner `memory` payload (a nested JSON string for schema/json working memory).
 * Returns the parseable prefix as an object so the bridge can emit an
 * incremental STATE_DELTA as the model writes the update; `undefined` while the
 * text is not yet a usable object (or is markdown-template working memory).
 */
function parseStreamingWorkingMemoryUpdate(
  argsText: string,
): Record<string, any> | undefined {
  if (!argsText) return undefined;
  const outer = parsePartialJson(argsText);
  const outerVal = outer.value;
  if (!outerVal || typeof outerVal !== "object" || Array.isArray(outerVal)) {
    return undefined;
  }
  const mem = (outerVal as Record<string, any>).memory;
  if (mem == null) return undefined;
  if (typeof mem === "object" && !Array.isArray(mem)) {
    return mem as Record<string, any>;
  }
  if (typeof mem === "string") {
    const inner = parsePartialJson(mem);
    const innerVal = inner.value;
    if (innerVal && typeof innerVal === "object" && !Array.isArray(innerVal)) {
      return innerVal as Record<string, any>;
    }
  }
  return undefined;
}

// Shape of a remote resume response. Newer @mastra/client-js exposes
// `resumeStream` on the remote Agent resource; it returns a Response augmented
// with `processDataStream`, the same callback-based stream the remote
// `.stream()` path consumes. The Agent resource of @mastra/client-js 1.0.0, the
// peer floor, has no `resumeStream`, so it is typed structurally and probed at
// runtime before use.
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

// A tool paused by Mastra's approval gate (`requireApproval` on the tool,
// `requireToolApproval` on the agent) streams `tool-call-approval` rather than
// `tool-call-suspended`, and only Mastra's approve / decline can complete it.
// The Interrupt's `metadata.mastra` carries this `type`; its id carries the
// prefix, since a ResumeEntry round-trips nothing but the id.
const TOOL_APPROVAL_TYPE = "mastra_tool_approval";
const TOOL_APPROVAL_ID_PREFIX = "mastra-approval::";

/**
 * Reads a tool approval answer: `true` or `{ approved: true }` approves,
 * `{ approved: false }` declines. Anything else returns `undefined`, which is
 * not an answer, so the run fails and the approval stays pending.
 */
function parseApprovalAnswer(resume: unknown): boolean | undefined {
  if (resume === true) return true;
  if (resume && typeof resume === "object") {
    const approved = (resume as { approved?: unknown }).approved;
    if (typeof approved === "boolean") return approved;
  }
  return undefined;
}

function describeResumeValue(value: unknown): string {
  if (value === undefined) return "no payload";
  try {
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 80)}...` : json;
  } catch {
    return typeof value;
  }
}

/**
 * What a run was asked to do about a suspended tool call, decoded from its
 * resume entry. `declined` comes from the entry's status, never from the
 * payload value, so a resolved entry with no payload still resumes an ordinary
 * suspend. An approval also accepts `{ approved: false }` as a decline and
 * rejects any other payload.
 */
interface ResumeDirective {
  interruptId: string;
  toolCallId: string;
  /** The id Mastra keys the suspended snapshot by. */
  snapshotRunId: string;
  approval: boolean;
  declined: boolean;
  resumeData: unknown;
}

/** A resume request the adapter rejects before touching the Mastra snapshot. */
class ResumeRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ResumeRequestError";
  }
}

/**
 * The events of one run, as they go out. It records what the run has opened so
 * that an ending can close it first (a RUN_FINISHED with anything still open
 * is rejected by consumers), and which tool calls went unanswered.
 */
class RunLifecycle {
  private readonly openReasoningMessages = new Set<string>();
  private readonly openReasoningSpans = new Set<string>();
  private readonly openToolCalls = new Set<string>();
  /** Every tool call the run started, by id, in the order it started them. */
  private readonly startedToolCalls = new Map<string, string>();
  private readonly answeredToolCalls = new Set<string>();
  /** Whether the run has emitted its RUN_FINISHED or RUN_ERROR. */
  ended = false;

  constructor(private readonly subscriber: Subscriber<BaseEvent>) {}

  readonly next = (event: BaseEvent): void => {
    switch (event.type) {
      case EventType.REASONING_START:
        this.openReasoningSpans.add((event as ReasoningStartEvent).messageId);
        break;
      case EventType.REASONING_END:
        this.openReasoningSpans.delete((event as ReasoningEndEvent).messageId);
        break;
      case EventType.REASONING_MESSAGE_START:
        this.openReasoningMessages.add(
          (event as ReasoningMessageStartEvent).messageId,
        );
        break;
      case EventType.REASONING_MESSAGE_END:
        this.openReasoningMessages.delete(
          (event as ReasoningMessageEndEvent).messageId,
        );
        break;
      case EventType.TOOL_CALL_START: {
        const { toolCallId, toolCallName } = event as ToolCallStartEvent;
        this.openToolCalls.add(toolCallId);
        if (!this.startedToolCalls.has(toolCallId)) {
          this.startedToolCalls.set(toolCallId, toolCallName);
        }
        break;
      }
      case EventType.TOOL_CALL_END:
        this.openToolCalls.delete((event as ToolCallEndEvent).toolCallId);
        break;
      case EventType.TOOL_CALL_RESULT:
        this.answeredToolCalls.add((event as ToolCallResultEvent).toolCallId);
        break;
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
        this.ended = true;
        break;
    }
    this.subscriber.next(event);
  };

  /** Closes every reasoning message, reasoning span and tool call still open. */
  closeOpen(): void {
    for (const messageId of [...this.openReasoningMessages]) {
      this.next({
        type: EventType.REASONING_MESSAGE_END,
        messageId,
      } as ReasoningMessageEndEvent);
    }
    for (const messageId of [...this.openReasoningSpans]) {
      this.next({
        type: EventType.REASONING_END,
        messageId,
      } as ReasoningEndEvent);
    }
    for (const toolCallId of [...this.openToolCalls]) {
      this.next({
        type: EventType.TOOL_CALL_END,
        toolCallId,
      } as ToolCallEndEvent);
    }
  }

  /**
   * The ids of the tool calls this run started and did not answer, in order,
   * when every one of them is a frontend tool named in `clientTools`: the calls
   * the application now owns. Undefined otherwise. When the list is sent it has
   * to be exactly the unanswered set, and one that includes a call the bridge
   * made for itself (a backgrounded server tool, the A2UI render subagent)
   * would ask the application to answer something it never offered, so none
   * is sent then and the consumer derives the list from the stream.
   */
  unansweredCallsOf(clientTools: Set<string>): string[] | undefined {
    const unanswered = [...this.startedToolCalls].filter(
      ([toolCallId]) => !this.answeredToolCalls.has(toolCallId),
    );
    if (unanswered.length === 0) return undefined;
    if (!unanswered.every(([, toolName]) => clientTools.has(toolName))) {
      return undefined;
    }
    return unanswered.map(([toolCallId]) => toolCallId);
  }
}

/**
 * Walks `finish.payload.response.uiMessages` to pull the final assistant text
 * after Mastra's output processors have run.
 *
 * Returns `undefined` when:
 *   - `uiMessages` is absent (older Mastra, or a non-finish chunk),
 *   - no assistant message is present,
 *   - the assistant message contains no text parts (tool-only response),
 * so callers can fall back to the buffered raw text.
 *
 * Accepts both string content and array-of-parts content shapes (Mastra's
 * UIMessage tolerates either depending on how the agent assembled its
 * response).
 */
function extractLastAssistantText(uiMessages: unknown): string | undefined {
  if (!Array.isArray(uiMessages)) return undefined;
  for (let i = uiMessages.length - 1; i >= 0; i--) {
    const message = uiMessages[i];
    if (!message || (message as { role?: string }).role !== "assistant") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content.length > 0 ? content : undefined;
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part: any): part is { type: "text"; text: string } =>
            part?.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("");
      return text.length > 0 ? text : undefined;
    }
    // Some UIMessage shapes expose pre-joined text via a `text` field.
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) return text;
    return undefined;
  }
  return undefined;
}

/**
 * AG-UI `activityType` used for Mastra Observational Memory (OM). OM is a
 * Mastra memory feature the developer enables on THEIR agent
 * (`new Memory({ options: { observationalMemory: true } })`). When enabled,
 * Mastra runs Observer/Reflector agents out of band that read the conversation,
 * compress it into observations, and activate them into the context window. OM
 * surfaces this background work on the agent's `fullStream` as typed
 * `data-om-*` chunks (see `@mastra/core/channels/om` + the `@mastra/memory` OM
 * processor). The bridge maps the substantive lifecycle of those chunks to
 * AG-UI ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events so the UI can render the
 * "agent is observing / reflecting / compressing memory" activity distinctly
 * from the streamed response. Renderers register against this string via
 * CopilotKit's `renderActivityMessages` prop.
 *
 * Surfacing is OPT-IN per agent (`MastraAgentConfig.observationalMemory`,
 * default OFF) — OM is the developer's own opt-in, so the bridge does not
 * announce it unless asked. With the toggle OFF the `data-om-*` chunks are
 * swallowed silently (they carry no assistant output), so an OM-enabled agent
 * still streams cleanly through the bridge and emits no activity.
 *
 * The activity `content` shape (one activity per OM cycle; `messageId` is the
 * Mastra `cycleId`). In the async path the buffering cycle and its activation
 * share one `cycleId`, so they advance a single activity
 * running -> completed -> activated:
 *
 *   {
 *     cycleId: string;        // Mastra OM cycle id (== activity messageId)
 *     operationType: "observation" | "reflection";
 *     phase: "observation" | "buffering" | "activation";
 *     status: "running" | "completed" | "failed" | "activated";
 *     threadId?: string;
 *     recordId?: string;
 *     observations?: string;  // the observation/reflection summary text
 *     currentTask?: string;       // task the Observer extracted
 *     suggestedResponse?: string; // suggestion the Observer extracted
 *     tokensToObserve?: number;   // observation/buffering: tokens in this batch
 *     tokensObserved?: number;    // observation: tokens observed
 *     bufferedTokens?: number;    // buffering: resulting tokens after compress
 *     observationTokens?: number; // resulting observation tokens
 *     tokensActivated?: number;   // activation: message tokens activated
 *     chunksActivated?: number;   // activation: buffered chunks activated
 *     messagesActivated?: number; // activation: messages observed via activation
 *     generationCount?: number;   // activation: reflection generation count
 *     triggeredBy?: "threshold" | "ttl" | "provider_change";
 *     durationMs?: number;
 *     startedAt?: string;     // ISO timestamp
 *     completedAt?: string;   // ISO timestamp
 *     error?: string;         // message on failure
 *   }
 *
 * This shape is a sensible default proposed by the AG-UI bridge; it mirrors the
 * background-task activity shape and may evolve alongside Mastra's OM data
 * parts (see OSS-92).
 */
export const MASTRA_OBSERVATIONAL_MEMORY_ACTIVITY_TYPE =
  "mastra-observational-memory";

/**
 * Mastra tracing options threaded into the underlying `agent.stream(...)` /
 * `agent.resumeStream(...)` call. Typed structurally (not against
 * `@mastra/core`) so the bridge compiles on any supported core in the peer
 * range — cores predating observability v-next simply ignore an unknown
 * `tracingOptions` key. Mirrors Mastra's `TracingOptions`:
 *   - `traceId`: a caller-chosen trace id to anchor the run under (lets a client
 *     self-assign a trace it already knows, e.g. to attach feedback later).
 *   - `metadata`: arbitrary key/values attached to the run's root trace span.
 */
export interface MastraTracingOptions {
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export interface MastraAgentConfig extends AgentConfig {
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  requestContext?: RequestContext;
  /**
   * Forward Mastra tracing options into the run's `agent.stream(...)` (and the
   * resume path). Chiefly lets a caller inject a self-chosen `traceId` so the
   * Mastra execution trace is anchored to an id the client already knows,
   * enabling trace-centric feedback/scores (`createFeedback({ traceId })`).
   *
   * NOT per-run: this config (and any `traceId` in it) is stored once on the
   * agent instance and reused verbatim for EVERY run of that instance. So a
   * config-level `tracingOptions.traceId` is applied to every run, not to a
   * single run, meaning a caller who sets a fixed `traceId` here and reuses one
   * `MastraAgent` across many runs collapses all those runs onto a single trace.
   * Callers who want a distinct traceId per run should construct a fresh agent
   * per run (the `registerCopilotKit` / `getLocalAgents` path already does this,
   * since agents are constructed inside the per-request route handler).
   *
   * The OUTBOUND execution traceId surfaced on `RUN_FINISHED.result` IS per-run:
   * when no inbound `traceId` is set, Mastra generates one for that run, which
   * the bridge surfaces back to the client (see {@link makeRunFinishedEvent}).
   * Inert on cores that predate Mastra observability v-next.
   */
  tracingOptions?: MastraTracingOptions;
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
   * Also open the tool-call family live (TOOL_CALL_START / ARGS / END as the
   * args stream) for SERVER tools, not only for client generative-UI tools.
   *
   * Default **false** — today's behavior. A server tool's call is buffered in
   * `pendingToolCall` and flushed by the NEXT chunk, which for an ordinary
   * sequential tool is its own `tool-result`: the subscriber then receives
   * START / ARGS / END / RESULT in one flush after the tool has already
   * finished, so a long-running server tool paints no "running" step at all.
   * Turn this on when your UI renders tool activity and you want that step to
   * appear while the tool runs.
   *
   * The reason it is opt-in: a live-streamed call cannot be retracted. The
   * buffer is what lets a following `tool-call-suspended` /
   * `background-task-started` suppress the normal tool render, and a call that
   * already emitted TOOL_CALL_START can only be CLOSED (TOOL_CALL_END), not
   * un-emitted. Under this option those two paths therefore close the streamed
   * call instead of suppressing it, and the consumer sees a tool call with no
   * TOOL_CALL_RESULT (the interrupt / activity carries the outcome, and the
   * activity retains the assembled tool arguments). If your server tools
   * suspend or run as background tasks, leave this off.
   */
  streamServerToolCalls?: boolean;
  /**
   * A2UI auto-injection config (local agents). When the runtime/middleware
   * forwards `injectA2UITool`, the bridge injects a backend-owned `generate_a2ui`
   * tool (recovery + subagent) per run so the developer wires nothing — the
   * easy-devex path. Set `injectA2UITool:false` here to force it off; set
   * `model`/`defaultCatalogId`/`guidelines`/`recovery` to customize. A `model` is
   * required for auto-inject unless one can be inferred from the wrapped agent.
   */
  a2ui?: A2UIInjectConfig;
  /**
   * For REMOTE agents only: the `MastraClient` used to reach the agent. When
   * set, the bridge syncs `input.state` into the remote server's working memory
   * (via `client.updateWorkingMemory`) before streaming, so a client-side edit
   * to shared state reaches a remote agent the same way it does a local one.
   * Set by `getRemoteAgents`; unused for local agents (which sync through their
   * own `Memory` instance).
   */
  remoteClient?: MastraClient;
  /**
   * When the configured agent uses `outputProcessors` that rewrite assistant
   * text (e.g. character-voice transforms, redaction, format normalization),
   * the processor-modified text is available only on the `finish` /
   * `step-finish` chunk's `payload.response.uiMessages` — surfaced upstream in
   * https://github.com/mastra-ai/mastra/pull/11549 to expose processor output
   * through streaming.
   *
   * Set to `true` to buffer intermediate `text-delta` chunks and emit only the
   * processor-modified text extracted from that boundary's `uiMessages`. When a
   * boundary has no usable `uiMessages` (older Mastra, or processors that did
   * not modify text), the buffered raw text is emitted on the terminal `finish`
   * as a fallback so no text is ever dropped.
   *
   * Default: `false` (current behavior — text-delta chunks stream to the client
   * in real time, processor rewrites are not surfaced).
   *
   * Trade-off: enabling this loses real-time text streaming — the final
   * assistant text appears at once after the agent's last step. Required when
   * downstream consumers (e.g. CopilotKit chat UI) must render the
   * post-processor text rather than the raw LLM output.
   *
   * Tracking: https://github.com/ag-ui-protocol/ag-ui/issues/1726
   */
  useProcessedFinalText?: boolean;
  /**
   * Surface Mastra Observational Memory (OM) background work as AG-UI activity
   * events (activityType `mastra-observational-memory`). Default OFF.
   *
   * OM is the developer's own opt-in (enabled on their Mastra `Memory`), so the
   * bridge stays silent about it unless explicitly asked. When `true`, the
   * bridge maps the OM lifecycle chunks Mastra streams on `fullStream`
   * (`data-om-observation-*`, `data-om-buffering-*`, `data-om-activation`) to
   * ACTIVITY_SNAPSHOT / ACTIVITY_DELTA events. When `false`/unset, those chunks
   * are swallowed (no activity emitted) but the stream still flows cleanly.
   *
   * Note: this toggle does NOT enable OM — that is configured on the agent's
   * Memory. It only controls whether the bridge surfaces OM's activity.
   */
  observationalMemory?: boolean;
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
  /**
   * Raw assistant text arrived but is being held for a later boundary
   * (`useProcessedFinalText`). Segment identity is decided from the state as it
   * is when the text arrives, not as it is when the text is finally released:
   * by then a tool call may have opened a boundary this text belongs before.
   */
  onTextBuffered?: () => void;
  onReasoningStart?: () => void;
  onReasoningPart?: (text: string) => void;
  onReasoningEnd?: () => void;
  /** Provider artefacts (signature, redacted data, provider metadata) of the current reasoning. */
  onReasoningArtifact?: (artifact: ReasoningArtifact) => void;
  onFinishMessagePart?: () => void;
  /** Emit TOOL_CALL_START. Fired once per tool call, before any args. */
  onToolCallStart?: (streamPart: {
    toolCallId: string;
    toolName: string;
  }) => void;
  /**
   * Emit a TOOL_CALL_ARGS delta. The bridge streams these incrementally as
   * Mastra emits `tool-call-delta` chunks (raw JSON-text fragments), or emits
   * a single full-args delta for a buffered call (a server tool, or a call
   * that streamed no deltas).
   */
  onToolCallArgs?: (streamPart: {
    toolCallId: string;
    argsTextDelta: string;
  }) => void;
  /** Emit TOOL_CALL_END. Fired once per tool call, after all args. */
  onToolCallEnd?: (streamPart: { toolCallId: string }) => void;
  /**
   * A resumed tool call the client already holds under `parentMessageId`.
   * Nothing is emitted for the call itself; later text on that id is placed
   * after its result, as it is after a streamed call.
   */
  onToolCallInHistory?: (streamPart: {
    toolCallId: string;
    parentMessageId: string;
  }) => void;
  onToolResultPart?: (streamPart: {
    toolCallId: string;
    result: any;
    /** The tool's model output (`toModelOutput`), when Mastra stored one. */
    modelOutput?: unknown;
  }) => void;
  onError: (error: Error) => void;
  /** Mastra reported the run stopped (an `abort` chunk). */
  onAbort?: () => void;
  /**
   * Terminate the run with RUN_FINISHED. Receives the Mastra execution traceId
   * (Mastra observability v-next) when the consumed stream exposed one, so the
   * bridge can surface it on `RUN_FINISHED.result` (see makeRunFinishedEvent).
   * traceId is undefined on cores/streams that don't expose one.
   */
  onRunFinished?: (traceId?: string, usage?: TokenUsage[]) => Promise<void>;
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
    // "approval" for a `tool-call-approval` pause; absent for a plain suspend.
    kind?: "approval";
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
  /**
   * Emit a STATE_SNAPSHOT (full shared state). Emitted once per run as the FIRST
   * working-memory state event, to establish the base the client/runtime patch
   * against — the AG-UI runtime applies STATE_DELTA from an empty document at
   * run start, so a leading snapshot is required or the first delta's paths are
   * unresolvable. Subsequent changes ride STATE_DELTA.
   */
  onStateSnapshot?: (snapshot: Record<string, any>) => void;
  /**
   * Emit a STATE_DELTA (RFC 6902 JSON patch) when the agent updates its working
   * memory mid-run. Emitted for every working-memory change AFTER the initial
   * snapshot, with the patch from the previously-known state to the post-update
   * state, so shared state renders live as it changes (the run-end
   * STATE_SNAPSHOT still follows).
   */
  onStateDelta?: (delta: Array<Record<string, any>>) => void;
}

export class MastraAgent extends AbstractAgent {
  /**
   * Backend agent id captured from `config.agentId`, read only by remote paths
   * so a runtime-assigned public alias does not change the backend target.
   * Unset (or empty) means remote paths fall back to the public `agentId`.
   */
  private readonly nativeAgentId?: string;
  agent: LocalMastraAgent | RemoteMastraAgent;
  resourceId?: string;
  requestContext?: RequestContext;
  untilIdle?: boolean | { maxIdleMs?: number };
  observationalMemory?: boolean;
  tracingOptions?: MastraTracingOptions;
  public headers?: Record<string, string>;
  /** See MastraAgentConfig.streamServerToolCalls. Default false. */
  streamServerToolCalls: boolean;
  /** See MastraAgentConfig.a2ui — A2UI auto-injection config. */
  a2ui?: A2UIInjectConfig;
  /** See MastraAgentConfig.remoteClient. Set for remote agents only. */
  remoteClient?: MastraClient;
  /** See MastraAgentConfig.useProcessedFinalText. Default false. */
  useProcessedFinalText: boolean;

  /**
   * Abort controllers for the currently in-flight runs — one per active
   * subscription, so overlapping subscriptions on the same MastraAgent each
   * get their own cancellation channel and none can orphan another's.
   *
   * Each controller is created in {@link run}, forwarded into Mastra as
   * `abortSignal` for LOCAL agents (see {@link streamMastraAgent}), used to
   * short-circuit the chunk-consumption loops for both local and remote, and
   * fired from that subscription's Observable teardown so unsubscribing
   * actually stops generation instead of billing the run to completion.
   * {@link abortRun} fires all of them.
   */
  private readonly abortControllers = new Set<AbortController>();

  /**
   * Suffix appended to a turn's base (Mastra-stored) messageId to key the
   * SEPARATE AG-UI message that carries assistant text streamed AFTER a tool
   * call in the same turn. See {@link continuationMessageId} and the ordering
   * note in {@link makeStreamCallbacks}.
   */
  private static readonly ASSISTANT_TEXT_CONTINUATION_SUFFIX = "-agui-text";

  /**
   * Matches any id produced by {@link continuationMessageId}, capturing the base
   * id it was derived from. Used by `selectNewMessages` to recognise the whole
   * continuation family of a stored turn without knowing how many segments the
   * turn had.
   */
  private static readonly CONTINUATION_ID_PATTERN = new RegExp(
    `^(.+)${MastraAgent.ASSISTANT_TEXT_CONTINUATION_SUFFIX}(?:-\\d+)?$`,
  );

  /**
   * Deterministic id for the `index`-th "trailing text" continuation message
   * split off a turn whose tool call already rendered under `baseId`. A turn can
   * alternate text -> tool -> text more than once, so each contiguous run of
   * text after a tool call gets its own index and therefore its own AG-UI
   * message (reusing one id makes the client append later segments onto the
   * message at its original index — run-on text above the cards it followed).
   *
   * Index 1 is the bare suffix, so single-boundary turns keep the exact id they
   * had before. Deterministic (a pure function of the stored turn id and the
   * segment index) so re-sent history dedups: `selectNewMessages` recognises the
   * whole family from each stored id and filters the continuation messages out,
   * so split text is never re-forwarded (and duplicated) on later turns.
   */
  private static continuationMessageId(baseId: string, index = 1): string {
    const suffix = MastraAgent.ASSISTANT_TEXT_CONTINUATION_SUFFIX;
    return index <= 1 ? `${baseId}${suffix}` : `${baseId}${suffix}-${index}`;
  }

  /**
   * The base id a continuation id was derived from, or null if `id` is not a
   * continuation id at all. Callers must still check the result against the ids
   * Mastra actually stored — the suffix shape alone does not make an id ours.
   */
  private static continuationBaseId(id: string): string | null {
    return MastraAgent.CONTINUATION_ID_PATTERN.exec(id)?.[1] ?? null;
  }

  constructor(private config: MastraAgentConfig) {
    const {
      agent,
      resourceId,
      requestContext,
      untilIdle,
      tracingOptions,
      streamServerToolCalls,
      a2ui,
      remoteClient,
      useProcessedFinalText,
      observationalMemory,
      ...rest
    } = config;
    super(rest);
    this.nativeAgentId = config.agentId || undefined;
    this.streamServerToolCalls = streamServerToolCalls ?? false;
    this.agent = agent;
    this.resourceId = resourceId;
    this.requestContext = requestContext ?? new RequestContext();
    this.untilIdle = untilIdle;
    this.a2ui = a2ui;
    this.remoteClient = remoteClient;
    this.useProcessedFinalText = useProcessedFinalText ?? false;
    this.observationalMemory = observationalMemory;
    this.tracingOptions = tracingOptions;
  }

  public clone() {
    const cloned = new MastraAgent({
      ...this.config,
      agentId: this.nativeAgentId,
    });
    // Constructed with the native id for backend calls; keep the public alias.
    cloned.agentId = this.agentId;
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
    // dedupes instead of duplicating. Streams that omit the start messageId
    // (it is optional on Mastra's step-start payload) keep using this fallback
    // (and the rotation below).
    let messageId = randomUUID();

    // Tool suspends collected this run, mapped to AG-UI Interrupts. The
    // terminating RUN_FINISHED carries them as its interrupt outcome (see
    // makeRunFinishedEvent).
    const pendingInterrupts: Interrupt[] = [];

    return new Observable<BaseEvent>((subscriber) => {
      // Cancellation channel for THIS subscription. The teardown below fires it
      // so unsubscribing (or abortRun()) propagates into the Mastra stream.
      const abortController = new AbortController();
      this.abortControllers.add(abortController);

      // Every event goes out through the lifecycle, which tracks what the run
      // has opened so that any ending can close it first.
      const lifecycle = new RunLifecycle(subscriber);

      // The frontend tools this run offered Mastra, which is what a run that
      // stops on one of them names in `pendingToolCallIds`. Starts as the
      // input's tools; a path narrows it once A2UI planning has run.
      let offeredClientTools = new Set(
        (input.tools ?? []).map((tool) => tool.name),
      );
      const setOfferedClientTools = (clientTools: Record<string, unknown>) => {
        offeredClientTools = new Set(Object.keys(clientTools));
      };

      // Set when Mastra itself reports the run stopped (an `abort` chunk).
      let mastraAborted = false;

      // A run stopped on purpose (abortRun(), or the remote handle's own
      // signal) closes what it opened and ends with RUN_FINISHED carrying the
      // cancelled outcome. It is settled here rather than by the consumption
      // loops, which only notice the signal when the producer yields again: a
      // gated or already-drained stream never does, which would leave the run
      // open forever.
      //
      // An unsubscribed run is abandoned, not cancelled: its subscriber is
      // already closed when the teardown fires this, so nothing is sent. The
      // same holds after the run has ended normally.
      abortController.signal.addEventListener(
        "abort",
        () => {
          if (subscriber.closed || lifecycle.ended) return;
          lifecycle.closeOpen();
          lifecycle.next(
            this.makeRunFinishedEvent(input, pendingInterrupts, {
              cancelled: true,
            }),
          );
          subscriber.complete();
        },
        { once: true },
      );

      lifecycle.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
        protocolVersion: PROTOCOL_VERSION,
      } as RunStartedEvent);

      // A caller-supplied `ClientOptions.abortSignal` on the remote handle (an
      // outer request disconnect or timeout) has to cancel this run too.
      // Chaining it into the run's controller keeps ONE cancellation channel,
      // so both sources take the identical path: the per-run handle stops the
      // producer and the listener above ends the run as cancelled. The per-run
      // handle swaps in this run's signal, so without the chain the outer one
      // would abort nothing.
      //
      // Chained after RUN_STARTED so an ALREADY-aborted caller signal ends a
      // run that has started.
      //
      // The chain listener is scoped to this run's own signal, so it is removed
      // when the run ends: a long-lived caller signal does not accumulate one
      // listener per run.
      const callerSignal = this.isLocalMastraAgent(this.agent)
        ? undefined
        : (this.agent.options?.abortSignal ??
          this.remoteClient?.options?.abortSignal);
      if (callerSignal?.aborted) {
        abortController.abort();
      } else if (callerSignal) {
        callerSignal.addEventListener("abort", () => abortController.abort(), {
          once: true,
          signal: abortController.signal,
        });
      }

      // The single failure exit for this run: exactly one RUN_ERROR, then the
      // Observable errors with the original error, so the existing failure
      // contract (rejections, onRunFailed, the Error itself) is unchanged.
      // runAgent() subscribers may not see the RUN_ERROR until the client
      // applies queued events before propagating a source error. A cancelled
      // run is settled by the abort listener above instead and reports nothing.
      const failRun = (error: unknown, code?: string) => {
        if (
          lifecycle.ended ||
          subscriber.closed ||
          abortController.signal.aborted
        ) {
          return;
        }
        lifecycle.next({
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : String(error),
          ...(code ? { code } : {}),
        } as RunErrorEvent);
        subscriber.error(error);
      };

      // The single non-failure exit once the run has produced its stream:
      // a best-effort working-memory snapshot (no-op for remote agents, which
      // have no local memory), then RUN_FINISHED. Shared by the stream, resume
      // and decline paths, so every run ends the same way.
      const finishRun = async (traceId?: string, usage?: TokenUsage[]) => {
        await this.emitWorkingMemorySnapshot(lifecycle, input.threadId);
        if (subscriber.closed || lifecycle.ended) return;
        lifecycle.closeOpen();
        lifecycle.next(
          this.makeRunFinishedEvent(input, pendingInterrupts, {
            cancelled: mastraAborted,
            traceId,
            usage,
            pendingToolCallIds: lifecycle.unansweredCallsOf(offeredClientTools),
          }),
        );
        subscriber.complete();
      };

      const run = async () => {
        if (abortController.signal.aborted) return;

        let directive: ResumeDirective | undefined;
        try {
          directive = this.resolveResumeDirective(input);
        } catch (error) {
          failRun(
            error,
            error instanceof ResumeRequestError ? error.code : undefined,
          );
          return;
        }

        // A cancelled entry means the user declined the tool call. Close the
        // run without calling resumeStream. A pending approval is completed by
        // Mastra either way: a decline has to reach declineToolCall, so it
        // takes the resume path below.
        if (directive?.declined && !directive.approval) {
          await finishRun();
          return;
        }

        if (directive) {
          // Checked before any Mastra call so a malformed answer leaves the
          // approval pending in Mastra, still answerable.
          const approved = directive.approval
            ? directive.declined
              ? false
              : parseApprovalAnswer(directive.resumeData)
            : undefined;
          if (directive.approval && approved === undefined) {
            const error = new ResumeRequestError(
              `Invalid tool approval answer for interrupt ${directive.interruptId} (toolCallId ${directive.toolCallId}): received ${describeResumeValue(directive.resumeData)}. ` +
                "Approve with true or { approved: true }; decline with { approved: false } or a cancelled entry. " +
                "The approval is still pending.",
              "MASTRA_INVALID_TOOL_APPROVAL",
            );
            failRun(error, error.code);
            return;
          }

          // Re-set this run's context so resume forwards it, not the prior turn's.
          const resumeRequestContext = this.applyInputContext(input.context);

          // Resume options are shared verbatim by the local and remote paths.
          // Mastra keys the suspended snapshot by the runId surfaced on the
          // suspend chunk (decoded from the interrupt id), NOT the AG-UI
          // RunAgentInput.runId: passing the latter fails remote resume with
          // "No snapshot found for this workflow run". The remote instance
          // loads that snapshot from configured storage, so `memory` must point
          // at the same thread/resource the suspended run used.
          //
          // The resumed run has to be offered the same tools as the run it
          // continues (#2667): the frontend tools from `RunAgentInput.tools`,
          // and — local only — the auto-injected A2UI toolset. Without them
          // the model sees no frontend tool after the suspended tool returns,
          // so an agent that answers exclusively through frontend tools ends
          // the resumed run with nothing on the wire. Both `clientTools` and
          // `toolsets` are part of the resume option surface: local
          // `Agent.resumeStream` takes `AgentExecutionOptionsBase`, and
          // @mastra/client-js `resumeStream` runs `clientTools` through
          // `processClientTools` like its `stream` does.
          const clientTools = this.buildClientTools(input.tools);
          const a2uiToolsets = await this.planA2UIToolsets(
            input,
            clientTools,
            resumeRequestContext,
          );
          setOfferedClientTools(clientTools);

          const resumeOptions: Record<string, unknown> = {
            toolCallId: directive.toolCallId,
            runId: directive.snapshotRunId,
            memory: {
              thread: input.threadId,
              resource: this.resourceId ?? input.threadId,
            },
            requestContext: resumeRequestContext,
            clientTools,
            ...(a2uiToolsets ? { toolsets: a2uiToolsets } : {}),
          };
          if (this.isLocalMastraAgent(this.agent)) {
            // LOCAL ONLY, mirroring the initial stream path: `untilIdle` pipes
            // the background-task lifecycle into this run's stream, which only
            // the in-process agent can do.
            if (this.untilIdle) {
              resumeOptions.untilIdle = this.untilIdle;
            }
            // LOCAL ONLY (#2288). @mastra/client-js excludes `abortSignal`
            // from its stream params (StreamParamsBase Omits it) and takes the
            // fetch signal from construction-time ClientOptions.abortSignal,
            // so a per-call signal would just be JSON-serialized into the POST
            // body as `{}`. The remote resume below carries this run's signal
            // on a per-run handle instead, see remoteAgentForRun.
            resumeOptions.abortSignal = abortController.signal;
          }
          if (this.tracingOptions) {
            resumeOptions.tracingOptions = this.tracingOptions;
          }
          if (this.headers && Object.keys(this.headers).length > 0) {
            resumeOptions.modelSettings = {
              ...((resumeOptions.modelSettings as
                | Record<string, unknown>
                | undefined) ?? {}),
              headers: this.headers,
            };
          }

          // A resume entry carries no tool name or arguments: the replayed
          // call takes them from Mastra's tool-result chunk.
          const resumeReplay = {
            toolCallId: directive.toolCallId,
            historyMessageId: (input.messages ?? []).find(
              (m) =>
                m.role === "assistant" &&
                m.toolCalls?.some((tc) => tc.id === directive.toolCallId),
            )?.id,
          };

          const callbacks = this.makeStreamCallbacks(
            lifecycle,
            () => messageId,
            (id) => {
              messageId = id;
            },
            input.runId,
            pendingInterrupts,
            input.messages,
          );
          const streamCallbacks: MastraAgentStreamOptions = {
            ...callbacks,
            onAbort: () => {
              mastraAborted = true;
            },
            onError: (error) => {
              failRun(error);
            },
          };

          try {
            if (this.isLocalMastraAgent(this.agent)) {
              type ApprovalOptions = Parameters<
                LocalMastraAgent["approveToolCall"]
              >[0];
              const response =
                approved === undefined
                  ? await this.agent.resumeStream(
                      directive.resumeData,
                      resumeOptions,
                    )
                  : approved
                    ? await this.agent.approveToolCall(
                        resumeOptions as ApprovalOptions,
                      )
                    : await this.agent.declineToolCall(
                        resumeOptions as ApprovalOptions,
                      );

              // Null/invalid response from resumeStream is an error
              if (
                !response ||
                typeof response !== "object" ||
                !response.fullStream
              ) {
                failRun(
                  new Error(
                    "resumeStream returned no valid response (missing fullStream)",
                  ),
                );
                return;
              }

              const outcome = await this.processFullStream(
                response.fullStream,
                streamCallbacks,
                abortController.signal,
                new Set(),
                {},
                resumeReplay,
              );

              // Cancelled resumes are settled by the abort listener in run();
              // errors have already gone out through onError.
              if (outcome === "completed") {
                await finishRun(
                  await this.resolveTraceId(response),
                  await this.resolveUsage(response),
                );
              }
            } else {
              // Remote resume round-trips the suspend state + resume command
              // over @mastra/client-js. The remote Agent's resumeStream returns
              // a processDataStream response (callback-based), so we drive it
              // through the same createChunkProcessor used by the remote
              // .stream() path — single source of truth for chunk handling.
              // Per-run handle so this run's signal reaches the fetch.
              const remoteAgent = this.remoteAgentForRun(
                abortController.signal,
              ) as unknown as Partial<RemoteResumableAgent>;
              if (typeof remoteAgent.resumeStream !== "function") {
                failRun(
                  new Error(
                    "Resume from interrupt requires a @mastra/client-js version that supports agent.resumeStream(); please upgrade @mastra/client-js",
                  ),
                );
                return;
              }

              // An approval resumes with `{ approved }`, which is exactly what
              // the server's approveToolCall / declineToolCall do. The
              // client-js approve / decline calls would drop `memory` and
              // `clientTools` from the request, so resumeStream is used.
              const response = await remoteAgent.resumeStream(
                approved === undefined ? directive.resumeData : { approved },
                resumeOptions,
              );

              if (
                !response ||
                typeof response.processDataStream !== "function"
              ) {
                failRun(
                  new Error(
                    "resumeStream returned no valid response (missing processDataStream)",
                  ),
                );
                return;
              }

              let stopped = false;
              const { handleChunk, flush, getUsage, releaseDeferredReplay } =
                this.createChunkProcessor(
                  streamCallbacks,
                  new Set(),
                  {},
                  resumeReplay,
                );

              try {
                await response.processDataStream({
                  onChunk: async (chunk: any) => {
                    if (stopped) return;
                    // Cancelled mid-resume: stop consuming (#2288).
                    if (abortController.signal.aborted) {
                      stopped = true;
                      return;
                    }
                    if (handleChunk(chunk)) stopped = true;
                  },
                });
              } catch (error) {
                // A resumed call already streamed must reach the client
                // before the failure.
                if (!abortController.signal.aborted) releaseDeferredReplay();
                throw error;
              }

              if (!stopped) {
                flush();
                await finishRun(
                  await this.resolveTraceId(response),
                  await this.resolveUsage(response, getUsage()),
                );
              }
            }
          } catch (error) {
            // Aborting the fetch rejects here. That is a cancellation, not a
            // failure: the run is settled by the abort listener above.
            if (abortController.signal.aborted) return;
            failRun(error);
          }
          return;
        }

        // Sync AG-UI input state into Mastra's working memory before streaming,
        // so a client-side edit to shared state (e.g. unchecking a dietary
        // preference in the recipe UI, then hitting "Improve") is what the agent
        // reads on the next run. Works for both local and remote agents (see
        // syncInputStateToWorkingMemory).
        try {
          await this.syncInputStateToWorkingMemory(input);
        } catch (error) {
          failRun(error);
          return;
        }

        try {
          const streamCallbacks = this.makeStreamCallbacks(
            lifecycle,
            () => messageId,
            (id) => {
              messageId = id;
            },
            input.runId,
            pendingInterrupts,
          );

          await this.streamMastraAgent(
            input,
            {
              ...streamCallbacks,
              onAbort: () => {
                mastraAborted = true;
              },
              onError: (error) => {
                failRun(error);
              },
              onRunFinished: finishRun,
            },
            abortController.signal,
            setOfferedClientTools,
          );
        } catch (error) {
          failRun(error);
        }
      };

      run().catch((err) => failRun(err));

      // Teardown runs on unsubscribe AND on normal completion (RxJS closes the
      // subscription either way), so it is the single place this run's
      // controller is retired. Aborting an already-finished stream is a no-op,
      // so this is safe on the completion path too.
      return () => {
        this.abortControllers.delete(abortController);
        abortController.abort();
      };
    });
  }

  /**
   * What this adapter supports, as an AG-UI capabilities declaration. Only
   * what the bridge actually does is declared; what depends on the configured
   * model or agent (modalities, parallel tool calls, the agent's own tools) is
   * left undeclared.
   */
  async getCapabilities(): Promise<AgentCapabilities> {
    // Shared state is Mastra working memory: an in-stream update goes out as
    // STATE_SNAPSHOT / STATE_DELTA, and a local agent's memory is snapshotted
    // at the end of each run. A local agent without memory has none.
    let workingMemory = true;
    if (this.isLocalMastraAgent(this.agent)) {
      try {
        workingMemory = !!(await this.agent.getMemory({
          requestContext: this.requestContext,
        }));
      } catch {
        workingMemory = false;
      }
    }
    return {
      identity: {
        type: "mastra",
        ...(this.agentId ? { name: this.agentId } : {}),
        ...(this.description ? { description: this.description } : {}),
      },
      tools: { supported: true, clientProvided: true },
      ...(workingMemory
        ? { state: { snapshots: true, deltas: true, persistentState: true } }
        : {}),
      reasoning: { supported: true, streaming: true, encrypted: true },
      humanInTheLoop: {
        supported: true,
        interrupts: true,
        approvals: true,
      },
    };
  }

  /**
   * Cancels every in-flight run on this agent, stopping generation at the
   * Mastra side. A run still subscribed ends with RUN_FINISHED carrying the
   * cancelled outcome.
   */
  public override abortRun(): void {
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
    super.abortRun();
  }

  isLocalMastraAgent(
    agent: LocalMastraAgent | RemoteMastraAgent,
  ): agent is LocalMastraAgent {
    return "getMemory" in agent;
  }

  /**
   * The remote agent handle to use for a single run.
   *
   * `@mastra/client-js` reads the fetch signal from `this.options.abortSignal`
   * on every request; its stream params Omit `abortSignal`, so a per-call
   * signal is only JSON-serialized into the POST body. The per-run handle is
   * the shared handle with only that signal swapped, so cancelling the run
   * aborts the fetch and stops the server-side run. The client also watches
   * the signal to tear down `processDataStream`.
   *
   * Delegating to the shared handle keeps its agent id, version pin, and route
   * overrides. Nothing is rebuilt from an id, so a handle whose agent differs
   * from the configured `agentId` still reaches the right agent.
   *
   * Returns the shared handle unchanged when there is no signal or the handle
   * has no real `ClientOptions` (a stand-in). Remote cancellation stays local
   * only in that case rather than failing the run.
   *
   * `abortSignal` replaces any `ClientOptions.abortSignal` on the copy, which is
   * safe because `run` chains the handle's own signal into this run's
   * controller, so the outer disconnect or timeout keeps being honoured.
   */
  private remoteAgentForRun(abortSignal?: AbortSignal): RemoteMastraAgent {
    const shared = this.agent as RemoteMastraAgent;
    if (!abortSignal || !shared.options?.baseUrl) return shared;
    return Object.create(shared, {
      options: { value: { ...shared.options, abortSignal } },
    }) as RemoteMastraAgent;
  }

  /**
   * Resolves this run's resume directive from `RunAgentInput.resume`. Mastra
   * fully overrides run(), so the base AbstractAgent handling of
   * `input.resume` is bypassed and it is consumed here.
   *
   * The Mastra snapshot runId (the resumeStream key) is NOT carried by a
   * ResumeEntry, only `interruptId` round-trips. So the emitted Interrupt id
   * encodes it as `${runId}::${toolCallId}` (see suspendToInterrupt) and it is
   * decoded back here.
   */
  private resolveResumeDirective(
    input: RunAgentInput,
  ): ResumeDirective | undefined {
    const entries = Array.isArray(input.resume) ? input.resume : [];
    if (entries.length === 0) return undefined;

    // One resumeStream call serves one interrupt. Resuming one sibling while
    // dropping the rest would half-advance the suspended snapshot, so reject
    // up front and leave it intact for a retry.
    if (entries.length > 1) {
      const ids = entries.map((entry) => entry?.interruptId).join(", ");
      throw new ResumeRequestError(
        `Mastra can resume one interrupt per run; received ${entries.length} resume entries: ${ids}. None were applied.`,
        "MASTRA_MULTIPLE_RESUME_ENTRIES",
      );
    }
    const [entry] = entries;
    if (
      typeof entry?.interruptId !== "string" ||
      entry.interruptId.length === 0 ||
      (entry.status !== "resolved" && entry.status !== "cancelled")
    ) {
      throw new ResumeRequestError(
        "Invalid resume entry: expected a non-empty interruptId and a status of resolved or cancelled",
      );
    }
    const approval = entry.interruptId.startsWith(TOOL_APPROVAL_ID_PREFIX);
    const encodedId = approval
      ? entry.interruptId.slice(TOOL_APPROVAL_ID_PREFIX.length)
      : entry.interruptId;
    const sep = encodedId.indexOf("::");
    const toolCallId = sep >= 0 ? encodedId.slice(sep + 2) : encodedId;
    if (toolCallId.length === 0) {
      throw new ResumeRequestError(
        `Invalid resume entry: interrupt ${entry.interruptId} names no tool call`,
      );
    }
    return {
      interruptId: entry.interruptId,
      toolCallId,
      snapshotRunId: sep > 0 ? encodedId.slice(0, sep) : input.runId,
      approval,
      declined: entry.status === "cancelled",
      resumeData: entry.payload,
    };
  }

  /**
   * Maps a Mastra tool suspend to an AG-UI {@link Interrupt}.
   *
   * `id` is the suspended tool call id — the correlation key resume sends back
   * (alongside `runId`) via `resumeStream`. `responseSchema` is the parsed
   * `resumeSchema` (Mastra hands it over as a JSON string). Everything the
   * resume round-trip needs that has no first-class Interrupt field
   * (`toolName`, `suspendPayload`, `args`, the snapshot-keying `runId`) is
   * preserved under `metadata.mastra`, the Mastra-specific payload renderers
   * read.
   */
  private suspendToInterrupt(
    payload: {
      toolCallId: string;
      toolName: string;
      suspendPayload: any;
      args: Record<string, any>;
      resumeSchema: string;
      runId?: string;
      kind?: "approval";
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
    // A client only round-trips `interruptId` in its ResumeEntry, not metadata,
    // so the id is the one channel that can carry the runId resume needs (see
    // resolveResumeDirective). `toolCallId` stays its own field for renderers.
    const snapshotRunId = payload.runId ?? runId;
    if (payload.kind === "approval") {
      return {
        id: `${TOOL_APPROVAL_ID_PREFIX}${snapshotRunId}::${payload.toolCallId}`,
        reason: "mastra:tool_approval",
        toolCallId: payload.toolCallId,
        ...(responseSchema ? { responseSchema } : {}),
        metadata: {
          mastra: {
            type: TOOL_APPROVAL_TYPE,
            toolName: payload.toolName,
            args: payload.args,
            resumeSchema: payload.resumeSchema,
            runId: snapshotRunId,
          },
        },
      };
    }
    return {
      id: `${snapshotRunId}::${payload.toolCallId}`,
      reason: "mastra:tool_suspend",
      ...(typeof payload.suspendPayload?.message === "string"
        ? { message: payload.suspendPayload.message }
        : {}),
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
   * Builds the terminating RUN_FINISHED for a run, with the outcome that says
   * how it ended:
   *   - cancelled, when the run was stopped on purpose (abortRun(), the remote
   *     handle's signal, or Mastra's own `abort`). It carries no result and no
   *     interrupts;
   *   - interrupt, when the run suspended at least one tool;
   *   - success naming `pendingToolCallIds`, when it stopped on frontend tool
   *     calls it left unanswered;
   *   - absent (success) otherwise.
   *
   * When the run exposed a Mastra execution traceId (Mastra observability
   * v-next), it is surfaced on `RUN_FINISHED.result` as `{ traceId }` so the
   * client/runtime can correlate the produced assistant message with its trace
   * (e.g. to anchor trace-centric feedback/scores). `result` is left unset
   * otherwise, preserving the prior event shape.
   */
  private makeRunFinishedEvent(
    input: Pick<RunAgentInput, "threadId" | "runId">,
    interrupts: Interrupt[],
    ending: {
      cancelled?: boolean;
      traceId?: string;
      usage?: TokenUsage[];
      pendingToolCallIds?: string[];
    } = {},
  ): RunFinishedEvent {
    const { cancelled, traceId, usage, pendingToolCallIds } = ending;
    const outcome: RunFinishedOutcome | undefined = cancelled
      ? { type: "cancelled" }
      : interrupts.length > 0
        ? { type: "interrupt", interrupts }
        : pendingToolCallIds && pendingToolCallIds.length > 0
          ? { type: "success", pendingToolCallIds }
          : undefined;
    return {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      ...(traceId && !cancelled ? { result: { traceId } } : {}),
      ...(outcome ? { outcome } : {}),
      ...(usage && usage.length > 0 ? { usage } : {}),
    } as RunFinishedEvent;
  }

  /**
   * Resolve provider-reported token usage from a Mastra/AI-SDK stream result.
   * AI-SDK v5 exposes a `usage` promise ({ inputTokens, outputTokens, ... });
   * we map it into a single per-run TokenUsage entry, labelling provider/model
   * from the local agent's model when discoverable. Best-effort: any failure
   * (no usage, remote agent, rejected promise) yields an empty array so the run
   * still finishes without usage.
   */
  private async resolveUsage(
    response: any,
    streamedUsage?: unknown,
  ): Promise<TokenUsage[]> {
    try {
      const raw = streamedUsage ?? (await response?.usage);
      const identity = this.getModelIdentity();
      const entry = tokenUsageFromAiSdkUsage(raw, identity);
      return entry ? [entry] : [];
    } catch {
      return [];
    }
  }

  /** Best-effort provider/model of the configured local agent (undefined for
   * remote agents or when the model doesn't expose these). */
  private getModelIdentity(): { provider?: string; model?: string } {
    const model = (this.agent as any)?.model;
    const provider =
      typeof model?.provider === "string" ? model.provider : undefined;
    const modelId =
      typeof model?.modelId === "string" ? model.modelId : undefined;
    return { provider, model: modelId };
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
    historyMessages: Message[] = [],
  ): Omit<MastraAgentStreamOptions, "onError" | "onRunFinished" | "onAbort"> {
    let reasoningMessageId: string | null = null;
    let isReasoning = false;
    // Provider artefacts of the open reasoning message, sent as
    // REASONING_ENCRYPTED_VALUE when it closes. An artefact arriving after the
    // message closed amends the last one; the event replaces the stored value
    // wholesale, so the merged whole is sent again.
    let reasoningArtifact: ReasoningArtifact = {};
    let lastReasoning: {
      messageId: string;
      artifact: ReasoningArtifact;
    } | null = null;
    const emitReasoningArtifact = (
      entityId: string,
      artifact: ReasoningArtifact,
    ) => {
      subscriber.next({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId,
        encryptedValue: encodeReasoningArtifact(artifact),
      } as ReasoningEncryptedValueEvent);
    };

    // --- Assistant message-ordering fix (backend tool -> trailing text) ------
    // Mastra assigns ONE messageId to an entire assistant turn and re-announces
    // it on each step-start, so a backend tool call and the model's final
    // narration text (streamed in a later step) both land under it. Under a
    // single AG-UI messageId CopilotKit draws a message's text BEFORE its tool
    // calls, so the narration renders ABOVE the tool card (and, for A2UI, above
    // the generated surface) even though it streamed LAST. To restore
    // card -> result -> text order, any assistant text that would stream under a
    // messageId that already carries a tool call is split into a SEPARATE
    // continuation message, keyed by a deterministic id derived from that id
    // (so re-sent history still dedups; see selectNewMessages).
    //
    // Keying off the tool call's own parent id (rather than a per-turn flag)
    // keeps the split correct whether Mastra re-announces the same id across the
    // step boundary (the real bug: text collapses onto the tool id) or omits
    // the id and relies on messageId rotation (each step already gets a fresh
    // id, so nothing collides and no split happens).
    // Per base id: how many tool->text boundaries have opened on it so far. 0
    // means no tool call has rendered under this id yet, so text keeps the base
    // id. Each further boundary bumps the index, giving that run of text its own
    // continuation message (#2380) — a turn can alternate more than once.
    const continuationIndexByParentId = new Map<string, number>();
    // Per base id: the highest continuation index already in history. A resumed
    // turn's first boundary starts past it so its text never appends onto a
    // continuation message an earlier run emitted.
    const historyContinuationIndex = new Map<string, number>();
    for (const { id } of historyMessages) {
      const base = MastraAgent.continuationBaseId(id);
      if (!base) continue;
      const suffix = id.slice(
        base.length + MastraAgent.ASSISTANT_TEXT_CONTINUATION_SUFFIX.length,
      );
      const index = suffix ? Number(suffix.slice(1)) : 1;
      historyContinuationIndex.set(
        base,
        Math.max(historyContinuationIndex.get(base) ?? 0, index),
      );
    }
    // Whether text has streamed since the last tool call on the current base id.
    // Back-to-back tool calls (parallel calls) must not burn a segment index.
    let textSinceLastToolCall = false;
    // The id the currently buffered segment was assigned when its first raw
    // delta arrived, held until that text is released. Only used under
    // `useProcessedFinalText`; undefined means nothing is being held.
    let bufferedSegmentMessageId: string | undefined;

    // The id a segment starting now would carry.
    const segmentMessageIdFor = (currentId: string) => {
      const segmentIndex = continuationIndexByParentId.get(currentId) ?? 0;
      return segmentIndex === 0
        ? currentId
        : MastraAgent.continuationMessageId(currentId, segmentIndex);
    };

    // Open a text-continuation boundary on the id a tool call renders under;
    // trailing text on the same id is then split to a continuation message
    // (see onTextPart). Only advance past the first boundary once text has
    // actually streamed into the current segment, so consecutive tool calls
    // share one boundary instead of skipping segment ids.
    const openToolCallBoundary = (parentMessageId: string) => {
      const openBoundaries = continuationIndexByParentId.get(parentMessageId);
      if (openBoundaries === undefined) {
        continuationIndexByParentId.set(
          parentMessageId,
          (historyContinuationIndex.get(parentMessageId) ?? 0) + 1,
        );
      } else if (textSinceLastToolCall) {
        continuationIndexByParentId.set(parentMessageId, openBoundaries + 1);
      }
      textSinceLastToolCall = false;
    };

    const closeReasoning = () => {
      if (isReasoning && reasoningMessageId) {
        subscriber.next({
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningMessageId,
        } as ReasoningMessageEndEvent);
        if (!isEmptyReasoningArtifact(reasoningArtifact)) {
          emitReasoningArtifact(reasoningMessageId, reasoningArtifact);
        }
        subscriber.next({
          type: EventType.REASONING_END,
          messageId: reasoningMessageId,
        } as ReasoningEndEvent);
        lastReasoning = {
          messageId: reasoningMessageId,
          artifact: reasoningArtifact,
        };
        reasoningArtifact = {};
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
      onReasoningArtifact: (artifact) => {
        if (isReasoning) {
          reasoningArtifact = mergeReasoningArtifact(
            reasoningArtifact,
            artifact,
          );
          return;
        }
        if (lastReasoning) {
          lastReasoning.artifact = mergeReasoningArtifact(
            lastReasoning.artifact,
            artifact,
          );
          emitReasoningArtifact(
            lastReasoning.messageId,
            lastReasoning.artifact,
          );
          return;
        }
        // Nothing to attach it to (a redacted block with no visible thinking):
        // the artefact gets a reasoning message of its own.
        openReasoning();
        reasoningArtifact = mergeReasoningArtifact(reasoningArtifact, artifact);
      },
      onTextPart: (text) => {
        closeReasoning();
        // If this text would stream under a messageId that already carries a
        // tool call, split it into its own continuation message so it renders
        // BELOW the tool card/result (see the ordering note above). Text under
        // a fresh id (no tool call on it) keeps that id — including text that
        // legitimately precedes a tool call in the same message.
        const currentId = getMessageId();
        // A held segment already chose its id, back when its text arrived.
        const textMessageId =
          bufferedSegmentMessageId ?? segmentMessageIdFor(currentId);
        bufferedSegmentMessageId = undefined;
        textSinceLastToolCall = true;
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          role: "assistant",
          messageId: textMessageId,
          delta: text,
        } as TextMessageChunkEvent);
      },
      onTextBuffered: () => {
        /*
         * Claim the id now, while the state still describes where this text sits.
         *
         * `textSinceLastToolCall` is deliberately not touched here. The release path sets it, and
         * a tool call arriving between the buffered deltas and that release is the case the flag
         * already handles correctly: the first boundary opens on it and a second consecutive tool
         * call does not burn an index. Setting it here as well changed no observable behaviour and
         * no test could distinguish it, so it is left out rather than shipped uncovered.
         */
        bufferedSegmentMessageId ??= segmentMessageIdFor(getMessageId());
      },
      onToolCallStart: (streamPart) => {
        closeReasoning();
        const parentMessageId = getMessageId();
        openToolCallBoundary(parentMessageId);
        subscriber.next({
          type: EventType.TOOL_CALL_START,
          parentMessageId,
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
      onToolCallInHistory: ({ parentMessageId }) => {
        closeReasoning();
        openToolCallBoundary(parentMessageId);
      },
      onToolResultPart: (streamPart) => {
        subscriber.next({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: streamPart.toolCallId,
          content: toolResultContent(streamPart.result, streamPart.modelOutput),
          messageId: randomUUID(),
          role: "tool",
        } as ToolCallResultEvent);
      },
      onToolSuspended: (payload) => {
        pendingInterrupts.push(this.suspendToInterrupt(payload, runId));
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
      onStateSnapshot: (snapshot) => {
        subscriber.next({
          type: EventType.STATE_SNAPSHOT,
          snapshot,
        } as StateSnapshotEvent);
      },
      onStateDelta: (delta) => {
        subscriber.next({
          type: EventType.STATE_DELTA,
          delta,
        } as StateDeltaEvent);
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
   * Buffered path: a server tool's call (and a call that streamed no deltas)
   * is held from its final `tool-call` chunk and emitted as a single START +
   * full-args ARGS + END when it flushes. This buffered path preserves the
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
   * @returns An object with three methods:
   *   - `handleChunk`: processes a single chunk; returns `true` if processing should stop (error or malformed chunk).
   *   - `flush`: emits any buffered tool-call and unresolved retry reason (call at end of stream).
   *   - `getUsage`: returns usage reported by the terminal `finish` chunk.
   */
  private createChunkProcessor(
    callbacks: MastraAgentStreamOptions,
    clientToolNames: Set<string> = new Set(),
    initialState: Record<string, any> = {},
    replaySuspendedToolCall?: {
      toolCallId: string;
      // The assistant message in `input.messages` that already holds the call.
      historyMessageId?: string;
    } | null,
  ) {
    // Remote processDataStream responses report token usage on the terminal
    // `finish` chunk rather than on the response object. Keep only that
    // boundary's value: `step-finish` can repeat usage for each model step and
    // would double-count the run if included.
    let usage: unknown;

    // Running client-side working-memory state, mapped to AG-UI shared state.
    // Seeded from the run's input.state (the base the client already holds), so
    // the first STATE_DELTA patches from what the UI shows, not from empty.
    // Each `updateWorkingMemory` tool call advances it and emits the patch.
    let workingMemoryState: Record<string, any> =
      initialState && typeof initialState === "object"
        ? { ...initialState }
        : {};
    // Tool call ids for `updateWorkingMemory` calls — used to suppress their
    // normal tool render (the update surfaces as STATE_DELTA, not a tool pill)
    // and to swallow the following `{ success: true }` tool-result.
    const workingMemoryToolCalls = new Set<string>();
    // The in-flight `updateWorkingMemory` call whose args are streaming: we
    // accumulate its raw `tool-call-delta` text and re-parse the growing prefix
    // so shared state renders progressively (field by field) rather than as one
    // blob when the call completes.
    let workingMemoryStream: { toolCallId: string; argsText: string } | null =
      null;

    // Whether we've emitted the leading STATE_SNAPSHOT for this run yet. The
    // AG-UI runtime applies STATE_DELTA against a document that starts EMPTY at
    // run start (it does not seed from input.state), so the first working-memory
    // state event MUST be a full STATE_SNAPSHOT — it establishes the base the
    // runtime and client patch against. Without it the first delta's paths (e.g.
    // `replace /recipe/skill_level`) are unresolvable → the runtime throws
    // OPERATION_PATH_UNRESOLVABLE, the run never finishes, and the Mastra thread
    // lock is never released ("Thread already running" on the next run).
    let stateSnapshotEmitted = false;

    // Advance the tracked shared state to the post-update value. The FIRST
    // change of a run is emitted as a STATE_SNAPSHOT (establishes the base);
    // every change after that as a STATE_DELTA (RFC-6902 patch, no-op if
    // nothing changed). Seeding `workingMemoryState` from input.state means the
    // snapshot preserves fields the streamed prefix hasn't written yet (no
    // transient collapse of the existing recipe). Shared by the streaming and
    // final-chunk paths so both advance the same state.
    const emitWorkingMemoryState = (
      update: Record<string, any> | undefined,
    ) => {
      if (update === undefined) return;
      const next = deepMergeWorkingMemory(workingMemoryState, update);
      if (!stateSnapshotEmitted) {
        stateSnapshotEmitted = true;
        workingMemoryState = next;
        callbacks.onStateSnapshot?.(next);
        return;
      }
      const patch = compare(workingMemoryState, next);
      if (patch.length > 0) {
        workingMemoryState = next;
        callbacks.onStateDelta?.(patch as Array<Record<string, any>>);
      }
    };

    // Whether to surface Observational Memory background work as activity
    // events. OFF by default — see MastraAgentConfig.observationalMemory.
    const surfaceOM = !!this.observationalMemory;

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

    // Opt-in (MastraAgentConfig.streamServerToolCalls): stream SERVER tools
    // live too, so a long-running one paints a "running" step instead of
    // appearing only once it has finished. The suspend / background arms below
    // close such a call rather than suppressing it — an emitted START cannot be
    // retracted.
    const streamsLive = (toolName?: string) =>
      isClientTool(toolName) || (this.streamServerToolCalls && !!toolName);

    // Buffered path: a final `tool-call` with no preceding live delta
    // stream is buffered here so a following tool-call-suspended /
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
    // Keep final arguments independently of the render buffer: a streamed
    // call may still become a background activity after its args have ended.
    const streamedToolCallArgs = new Map<string, unknown>();

    // Skipped / unrecognized chunk types warn at most once each. Mastra 1.31+
    // custom-data streams (e.g. `data-*` via context.writer.custom) can emit
    // the same payload-less type at high frequency; a per-chunk warn would
    // flood the log (#1635). Dedupe by type so integrators still see the
    // message without the spam.
    const warnedChunkTypes = new Set<string>();
    const warnOnce = (type: string | undefined, message: string) => {
      const key = type ?? "undefined";
      if (warnedChunkTypes.has(key)) return;
      warnedChunkTypes.add(key);
      console.warn(`[MastraAgent] ${message}: type=${key}`);
    };

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

    // Whether this stream has announced the native message id yet. Until it
    // has, the current id is the run's own fallback.
    let messageIdAnnounced = false;
    const adoptMessageId = (messageId: string) => {
      messageIdAnnounced = true;
      callbacks.onMessageId?.(messageId);
    };

    const reportReasoningArtifact = (
      artifact: ReasoningArtifact | undefined,
    ) => {
      if (artifact && !isEmptyReasoningArtifact(artifact)) {
        callbacks.onReasoningArtifact?.(artifact);
      }
    };

    const isWorkingMemoryResult = (payload: any) =>
      workingMemoryToolCalls.has(payload?.toolCallId) ||
      WORKING_MEMORY_TOOL_NAMES.has(payload?.toolName);

    const emitReplayedToolCall = (
      toolCallId: string,
      toolName: string,
      args: unknown,
    ) => {
      callbacks.onToolCallStart?.({ toolCallId, toolName });
      callbacks.onToolCallArgs?.({
        toolCallId,
        argsTextDelta: JSON.stringify(args ?? {}),
      });
      callbacks.onToolCallEnd?.({ toolCallId });
      streamedStarted.add(toolCallId);
      streamedEnded.add(toolCallId);
    };

    // A resumed call and its result, held until the stream announces the id
    // Mastra stores the call under (see the `tool-result` arm).
    let deferredReplay: {
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: unknown;
      modelOutput: unknown;
    } | null = null;

    const releaseDeferredReplay = () => {
      if (!deferredReplay) return;
      const { toolCallId, toolName, args, result, modelOutput } =
        deferredReplay;
      deferredReplay = null;
      emitReplayedToolCall(toolCallId, toolName, args);
      callbacks.onToolResultPart?.({ toolCallId, result, modelOutput });
    };

    // Release the held replay ahead of any chunk that produces output, under
    // the id that chunk announces if it carries one. Chunks that emit nothing
    // keep holding it.
    const settleDeferredReplay = (chunk: any) => {
      const type = chunk?.type;
      if (typeof type === "string" && type.startsWith("data-om-")) {
        if (!surfaceOM || !SURFACED_OM_CHUNK_TYPES.has(type)) return;
      } else if (
        !chunk?.payload ||
        SILENT_CHUNK_TYPES.has(type) ||
        (type === "tool-result" && isWorkingMemoryResult(chunk.payload))
      ) {
        return;
      }
      if (MESSAGE_ID_CHUNK_TYPES.has(type) && chunk.payload?.messageId) {
        adoptMessageId(chunk.payload.messageId);
      }
      releaseDeferredReplay();
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
        streamedStarted.add(toolCallId);
        streamedEnded.add(toolCallId);
      }
    };

    // --- useProcessedFinalText buffering ------------------------------------
    // When the flag is on, `text-delta` chunks are accumulated here instead of
    // streamed, and the assistant text is emitted once per boundary from the
    // processor-modified `finish.payload.response.uiMessages` (falling back to
    // this raw buffer on the terminal `finish`). All of this is inert when the
    // flag is off — bufferedText stays "" and the release helpers early-return.
    let bufferedText = "";
    // A retry request can still be terminal (e.g. an input processor abort).
    // Keep its reason until a new response arrives or the stream ends.
    let pendingRetryReason: string | undefined;
    // The last text we emitted within the current message window. Mastra ends a
    // response with a `step-finish` immediately followed by a terminal `finish`,
    // and BOTH can carry the same `response.uiMessages`; without this guard the
    // second boundary would re-emit the identical text as a duplicate bubble
    // (under the already-rotated messageId). Reset on each start / step-start so
    // dedup is scoped to one message and never suppresses distinct per-step text.
    let lastEmittedText: string | undefined;

    // Emit `text` as one assistant TEXT_MESSAGE_CHUNK, skipping an exact repeat
    // of what we just emitted for this message (see lastEmittedText).
    const emitProcessedText = (text: string) => {
      if (text === lastEmittedText) return;
      callbacks.onTextPart?.(text);
      lastEmittedText = text;
    };

    // Release buffered/processed assistant text at a finish boundary. Prefers
    // the processor-modified text from `uiMessages`; on the terminal `finish`
    // falls back to the raw buffer so nothing is dropped. On a non-terminal
    // `step-finish` with no `uiMessages`, keeps buffering (the text may still be
    // rewritten and surfaced on a later boundary — emitting raw now then
    // processed later would double-render).
    const releaseBufferedText = (chunkPayload: any, isTerminal: boolean) => {
      if (!this.useProcessedFinalText) return;
      const processedText = extractLastAssistantText(
        chunkPayload?.response?.uiMessages,
      );
      if (processedText !== undefined) {
        pendingRetryReason = undefined;
        bufferedText = "";
        emitProcessedText(processedText);
        return;
      }
      if (isTerminal && bufferedText) {
        const raw = bufferedText;
        bufferedText = "";
        emitProcessedText(raw);
      }
    };

    // Flush the raw buffer as-is (used when a turn ends without a `finish`, e.g.
    // a tool suspend/interrupt) so text streamed before the interrupt is not
    // lost. No-op when the flag is off or nothing is buffered.
    const flushBufferedTextRaw = () => {
      if (!this.useProcessedFinalText || !bufferedText) return;
      const raw = bufferedText;
      bufferedText = "";
      emitProcessedText(raw);
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

    // --- Observational Memory (OM) activity ---------------------------------
    // cycleIds for which an OM ACTIVITY_SNAPSHOT has been emitted. Guards
    // against emitting a delta before its snapshot.
    const knownOmCycles = new Set<string>();

    const ensureOmSnapshot = (
      cycleId: string,
      content: Record<string, any>,
    ) => {
      if (!cycleId || knownOmCycles.has(cycleId)) return;
      knownOmCycles.add(cycleId);
      callbacks.onActivitySnapshot?.({
        messageId: cycleId,
        activityType: MASTRA_OBSERVATIONAL_MEMORY_ACTIVITY_TYPE,
        content: { cycleId, ...content },
      });
    };

    const emitOmDelta = (
      cycleId: string,
      patch: Array<Record<string, any>>,
    ) => {
      if (!cycleId || patch.length === 0) return;
      callbacks.onActivityDelta?.({
        messageId: cycleId,
        activityType: MASTRA_OBSERVATIONAL_MEMORY_ACTIVITY_TYPE,
        patch,
      });
    };

    // Build a JSON-patch "add" op for each defined field on `data` under
    // `keyMap` (sourceKey -> activity content path). Skips undefined values so
    // the delta stays minimal. Date values are normalised to ISO strings.
    const omPatch = (
      data: Record<string, any>,
      keyMap: Record<string, string>,
    ): Array<Record<string, any>> => {
      const patch: Array<Record<string, any>> = [];
      for (const [src, path] of Object.entries(keyMap)) {
        const value = data?.[src];
        if (value === undefined) continue;
        patch.push({ op: "add", path: `/${path}`, value: toISO(value) });
      }
      return patch;
    };

    // Map a single OM `data-om-*` chunk to activity events. Snapshot on the
    // start of a cycle, delta on its end/failure; activation is terminal so it
    // is a snapshot of its own. Only the substantive lifecycle is surfaced —
    // `data-om-status` (periodic token-window gauge), `data-om-thread-update`
    // (title changes) and the deprecated `data-om-observed` are intentionally
    // ignored (still swallowed, never a stream-stopper). The cycleId round-trips
    // as the activity messageId so start/end address the same activity message.
    const handleOmChunk = (chunk: any): void => {
      const data = chunk?.data ?? {};
      const cycleId: string | undefined = data.cycleId;
      switch (chunk.type) {
        case "data-om-observation-start": {
          if (!cycleId) break;
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "observation",
            status: "running",
            ...(data.threadId !== undefined && { threadId: data.threadId }),
            ...(data.recordId !== undefined && { recordId: data.recordId }),
            ...(data.startedAt !== undefined && {
              startedAt: toISO(data.startedAt),
            }),
            ...(data.tokensToObserve !== undefined && {
              tokensToObserve: data.tokensToObserve,
            }),
          });
          break;
        }
        case "data-om-buffering-start": {
          if (!cycleId) break;
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "buffering",
            status: "running",
            ...(data.threadId !== undefined && { threadId: data.threadId }),
            ...(data.recordId !== undefined && { recordId: data.recordId }),
            ...(data.startedAt !== undefined && {
              startedAt: toISO(data.startedAt),
            }),
            ...(data.tokensToBuffer !== undefined && {
              tokensToBuffer: data.tokensToBuffer,
            }),
          });
          break;
        }
        case "data-om-observation-end": {
          if (!cycleId) break;
          // Defensive: seed a snapshot if the start chunk was missed.
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "observation",
            status: "running",
          });
          emitOmDelta(cycleId, [
            { op: "add", path: "/status", value: "completed" },
            ...omPatch(data, {
              completedAt: "completedAt",
              durationMs: "durationMs",
              tokensObserved: "tokensObserved",
              observationTokens: "observationTokens",
              observations: "observations",
              currentTask: "currentTask",
              suggestedResponse: "suggestedResponse",
            }),
          ]);
          break;
        }
        case "data-om-buffering-end": {
          if (!cycleId) break;
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase: "buffering",
            status: "running",
          });
          emitOmDelta(cycleId, [
            { op: "add", path: "/status", value: "completed" },
            ...omPatch(data, {
              completedAt: "completedAt",
              durationMs: "durationMs",
              tokensBuffered: "tokensBuffered",
              bufferedTokens: "bufferedTokens",
              observations: "observations",
            }),
          ]);
          break;
        }
        case "data-om-observation-failed":
        case "data-om-buffering-failed": {
          if (!cycleId) break;
          const phase =
            chunk.type === "data-om-buffering-failed"
              ? "buffering"
              : "observation";
          ensureOmSnapshot(cycleId, {
            operationType: data.operationType,
            phase,
            status: "running",
          });
          emitOmDelta(cycleId, [
            { op: "add", path: "/status", value: "failed" },
            {
              op: "add",
              path: "/error",
              value: data.error ?? "Unknown error",
            },
            ...omPatch(data, {
              failedAt: "completedAt",
              durationMs: "durationMs",
            }),
          ]);
          break;
        }
        case "data-om-activation": {
          // Activation moves buffered observations into the active context. In
          // the async path it REUSES the buffering cycle's id (buffering-start/
          // -end then activation all share one cycleId), so when the cycle is
          // already known this is the terminal DELTA that advances that activity
          // to "activated". When the cycle is unknown (defensive / a future path
          // that activates without a prior buffering cycle on this stream) it is
          // a self-contained snapshot.
          if (!cycleId) break;
          const activationPatch = (data: Record<string, any>) =>
            omPatch(data, {
              activatedAt: "completedAt",
              chunksActivated: "chunksActivated",
              tokensActivated: "tokensActivated",
              observationTokens: "observationTokens",
              messagesActivated: "messagesActivated",
              generationCount: "generationCount",
              triggeredBy: "triggeredBy",
              observations: "observations",
            });
          if (knownOmCycles.has(cycleId)) {
            emitOmDelta(cycleId, [
              { op: "add", path: "/phase", value: "activation" },
              { op: "add", path: "/status", value: "activated" },
              ...activationPatch(data),
            ]);
          } else {
            ensureOmSnapshot(cycleId, {
              operationType: data.operationType,
              phase: "activation",
              status: "activated",
              ...(data.threadId !== undefined && { threadId: data.threadId }),
              ...(data.recordId !== undefined && { recordId: data.recordId }),
              ...(data.activatedAt !== undefined && {
                completedAt: toISO(data.activatedAt),
              }),
              ...(data.chunksActivated !== undefined && {
                chunksActivated: data.chunksActivated,
              }),
              ...(data.tokensActivated !== undefined && {
                tokensActivated: data.tokensActivated,
              }),
              ...(data.observationTokens !== undefined && {
                observationTokens: data.observationTokens,
              }),
              ...(data.messagesActivated !== undefined && {
                messagesActivated: data.messagesActivated,
              }),
              ...(data.generationCount !== undefined && {
                generationCount: data.generationCount,
              }),
              ...(data.triggeredBy !== undefined && {
                triggeredBy: data.triggeredBy,
              }),
              ...(data.observations !== undefined && {
                observations: data.observations,
              }),
            });
          }
          break;
        }
        default:
          // data-om-status / data-om-thread-update / data-om-observed and any
          // future data-om-* part: swallow without surfacing.
          break;
      }
    };

    const handleChunk = (chunk: any): boolean => {
      if (deferredReplay) settleDeferredReplay(chunk);

      // Observational Memory data parts arrive on fullStream as
      // `{ type: "data-om-*", data: {...} }` (no `payload`). Handle them before
      // the payload guard below so they map to activity when surfacing is on,
      // and are swallowed silently (no warn) when off — an OM-enabled agent
      // still streams cleanly and emits no activity.
      if (
        typeof chunk?.type === "string" &&
        chunk.type.startsWith("data-om-")
      ) {
        if (surfaceOM) handleOmChunk(chunk);
        return false;
      }

      // Other chunks without a `payload` are not fatal. Mastra 1.31+ emits
      // custom-data chunks (e.g. `data-*` types via context.writer.custom)
      // that carry `data` instead of `payload`, plus new lifecycle chunk
      // types this switch doesn't recognize. Skip them gracefully (warn,
      // return false) so the rest of the stream — including RUN_FINISHED —
      // still flows, rather than aborting the run.
      if (!chunk || !chunk.payload) {
        warnOnce(chunk?.type, "Skipping stream chunk without payload");
        return false;
      }
      switch (chunk.type) {
        // A reasoning chunk's provider artefacts ride its `providerMetadata`
        // (and `signature`, on start/end); they are sent to the client as
        // REASONING_ENCRYPTED_VALUE for the reasoning message they belong to.
        case "reasoning-start": {
          callbacks.onReasoningStart?.();
          reportReasoningArtifact(readReasoningArtifact(chunk.payload));
          break;
        }
        case "reasoning-delta": {
          callbacks.onReasoningPart?.(chunk.payload.text);
          reportReasoningArtifact(readReasoningArtifact(chunk.payload));
          break;
        }
        case "reasoning-end": {
          reportReasoningArtifact(readReasoningArtifact(chunk.payload));
          callbacks.onReasoningEnd?.();
          break;
        }
        // Declared by Mastra's ChunkType (the AI SDK v4 reasoning artefacts).
        case "reasoning-signature": {
          reportReasoningArtifact(readReasoningArtifact(chunk.payload));
          break;
        }
        case "redacted-reasoning": {
          reportReasoningArtifact(
            mergeReasoningArtifact(readReasoningArtifact(chunk.payload) ?? {}, {
              redactedData: chunk.payload.data,
            }),
          );
          break;
        }
        // Mastra 1.31+ text lifecycle markers bracket the `text-delta` chunks.
        // AG-UI streams text via TEXT_MESSAGE_CHUNK and derives message
        // boundaries from start/finish + messageId rotation, so these markers
        // need no action — recognize them so they don't hit the `default:`
        // warning flood (#1635, #836).
        case "text-start":
        case "text-end":
          break;
        // A standalone (non-background) `tool-output` streams intermediate tool
        // output. The bridge surfaces completed tool results via `tool-result`;
        // there is no AG-UI mapping for interim output, so ignore it. (Task
        // output under a backgrounded tool is consumed inside
        // `background-task-output`, not here.) Recognized to avoid the warn.
        case "tool-output":
          break;
        case "text-delta": {
          if (chunk.payload.text) pendingRetryReason = undefined;
          flush();
          if (this.useProcessedFinalText) {
            // Hold deltas until a finish boundary — the processor-modified text
            // arrives via finish.payload.response.uiMessages.
            bufferedText += chunk.payload.text;
            callbacks.onTextBuffered?.();
          } else {
            callbacks.onTextPart?.(chunk.payload.text);
          }
          break;
        }
        // Tool-call args stream incrementally: start → delta(s) → end → the
        // final `tool-call`. For CLIENT tools we emit these live (progressive
        // render). For SERVER tools we ignore the delta chunks and buffer the
        // final `tool-call` (below) so it stays suppressible.
        case "tool-call-input-streaming-start": {
          // A new tool call begins: flush any prior buffered call.
          flush();
          // Working-memory update: capture its streaming args so we can emit
          // progressive STATE_DELTAs (below). It never renders as a tool.
          if (
            chunk.payload.toolCallId &&
            WORKING_MEMORY_TOOL_NAMES.has(chunk.payload.toolName)
          ) {
            workingMemoryStream = {
              toolCallId: chunk.payload.toolCallId,
              argsText: "",
            };
            workingMemoryToolCalls.add(chunk.payload.toolCallId);
            break;
          }
          if (chunk.payload.toolCallId && streamsLive(chunk.payload.toolName)) {
            startStreamedToolCall(
              chunk.payload.toolCallId,
              chunk.payload.toolName,
            );
          }
          break;
        }
        case "tool-call-delta": {
          const { toolCallId, argsTextDelta } = chunk.payload;
          // Working-memory update streaming: accumulate the raw args text and
          // re-parse the growing prefix, emitting an incremental STATE_DELTA as
          // the model writes the update (progressive shared-state render).
          if (
            workingMemoryStream &&
            toolCallId === workingMemoryStream.toolCallId
          ) {
            if (argsTextDelta != null) {
              workingMemoryStream.argsText += argsTextDelta;
              emitWorkingMemoryState(
                parseStreamingWorkingMemoryUpdate(workingMemoryStream.argsText),
              );
            }
            break;
          }
          // Only forward deltas for a call we opened as a live stream (client
          // tools, plus server tools under streamServerToolCalls). Deltas for a
          // buffered call are ignored; its args ride the final `tool-call`
          // chunk into the buffered path.
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
          if (
            workingMemoryStream &&
            chunk.payload.toolCallId === workingMemoryStream.toolCallId
          ) {
            // Args fully streamed; the authoritative final state is emitted from
            // the following `tool-call` chunk (its assembled object). Stop
            // accumulating; keep the id suppressed for the tool-result.
            workingMemoryStream = null;
            break;
          }
          if (chunk.payload.toolCallId) {
            endStreamedToolCall(chunk.payload.toolCallId);
          }
          break;
        }
        case "tool-call": {
          pendingRetryReason = undefined;
          const { toolCallId, toolName, args } = chunk.payload;
          // Working-memory update: Mastra's built-in `updateWorkingMemory` tool.
          // The assembled args carry the final (authoritative) working memory —
          // emit a STATE_DELTA to it (a no-op patch if the streamed deltas above
          // already converged, or the whole change on the fall-back path where
          // no arg-deltas streamed). Suppress the normal tool render; the
          // `{ success: true }` result is swallowed below. A preceding buffered
          // call still flushes first.
          if (toolName && WORKING_MEMORY_TOOL_NAMES.has(toolName)) {
            flush();
            if (toolCallId) workingMemoryToolCalls.add(toolCallId);
            if (
              workingMemoryStream &&
              workingMemoryStream.toolCallId === toolCallId
            ) {
              workingMemoryStream = null;
            }
            emitWorkingMemoryState(parseWorkingMemoryUpdate(args));
            break;
          }
          if (toolCallId && streamedStarted.has(toolCallId)) {
            // Args were already streamed live via deltas — close
            // the call (the streaming-end chunk may have been absent) and don't
            // re-emit. Retain the assembled args for a background handoff.
            streamedToolCallArgs.set(toolCallId, args);
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
          streamedToolCallArgs.delete(chunk.payload.toolCallId);
          // Swallow the `{ success: true }` result of a working-memory update —
          // its tool-call was mapped to STATE_DELTA and never rendered, so a
          // TOOL_CALL_RESULT here would have no matching call (and is internal
          // plumbing regardless).
          // Matched by name too: a resumed stream carries the result of a
          // call made in the previous run.
          if (isWorkingMemoryResult(chunk.payload)) {
            workingMemoryToolCalls.delete(chunk.payload.toolCallId);
            break;
          }
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
          // Resume of a tool that suspended on the previous run: that run
          // discarded TOOL_CALL_START/ARGS/END (by design), so CopilotKit
          // never registered the id. Emit the triple now from the interrupt
          // snapshot before TOOL_CALL_RESULT, otherwise the result is
          // orphaned (#2668). Skip when START was already emitted (buffered
          // flush or live deltas). Do not emit on the first-run suspend path
          // (replay is unset). A resume entry does not round-trip the name or
          // args; Mastra puts them on tool-result instead.
          //
          // The call belongs to the message Mastra stores it under. When the
          // client already holds it there, re-emitting would add a second
          // copy (and ARGS would append to its arguments), so only the result
          // goes out. Otherwise the result arrives before the stream announces
          // that id, so the triple and result wait for it.
          if (
            replaySuspendedToolCall &&
            replaySuspendedToolCall.toolCallId === chunk.payload.toolCallId &&
            !streamedStarted.has(chunk.payload.toolCallId)
          ) {
            const { toolCallId, historyMessageId } = replaySuspendedToolCall;
            const toolName = chunk.payload.toolName || "tool";
            const args = chunk.payload.args ?? {};
            if (historyMessageId) {
              if (!messageIdAnnounced) adoptMessageId(historyMessageId);
              callbacks.onToolCallInHistory?.({
                toolCallId,
                parentMessageId: historyMessageId,
              });
              streamedStarted.add(toolCallId);
              streamedEnded.add(toolCallId);
            } else if (!messageIdAnnounced) {
              deferredReplay = {
                toolCallId,
                toolName,
                args,
                result: chunk.payload.result,
                modelOutput: readModelOutput(chunk.payload.providerMetadata),
              };
              break;
            } else {
              emitReplayedToolCall(toolCallId, toolName, args);
            }
          }
          callbacks.onToolResultPart?.({
            toolCallId: chunk.payload.toolCallId,
            result: chunk.payload.result,
            modelOutput: readModelOutput(chunk.payload.providerMetadata),
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
        // A2UI progressive streaming (pillar 2): the auto-injected / explicit
        // `generate_a2ui` tool runs its `render_a2ui` subagent via `.stream()`
        // and pushes the render call's arg deltas onto this stream as custom
        // `data-a2ui-render` chunks (see @ag-ui/mastra a2ui-tool renderSubagent).
        // Translate them into synthetic INNER `render_a2ui` TOOL_CALL_* events so
        // the @ag-ui/a2ui-middleware paints the "building" skeleton + fills the
        // surface incrementally instead of bulk-painting the final envelope.
        case "data-a2ui-render": {
          const p = chunk.payload as {
            phase?: string;
            toolCallId?: string;
            toolName?: string;
            argsTextDelta?: string;
          };
          if (!p.toolCallId) break;
          if (p.phase === "start") {
            // Flush the buffered OUTER `generate_a2ui` tool-call onto the wire
            // FIRST, so the A2UIMiddleware has registered it as the active outer
            // call before this inner `render_a2ui` starts. That keys the streamed
            // surface to the outer call, so the final generate_a2ui result
            // envelope lands on the SAME activity id and REPLACES the streamed
            // surface (single paint) instead of duplicating it — and lets the
            // envelope be intercepted (no residual generate_a2ui tool card).
            flush();
            callbacks.onToolCallStart?.({
              toolCallId: p.toolCallId,
              toolName: p.toolName ?? "render_a2ui",
            });
          } else if (p.phase === "delta") {
            if (p.argsTextDelta != null) {
              callbacks.onToolCallArgs?.({
                toolCallId: p.toolCallId,
                argsTextDelta: p.argsTextDelta,
              });
            }
          } else if (p.phase === "end") {
            callbacks.onToolCallEnd?.({ toolCallId: p.toolCallId });
          }
          break;
        }
        // An approval pause is a suspend Mastra raised on the tool's behalf:
        // same buffering and interrupt, but resumed by approve / decline.
        case "tool-call-approval":
        case "tool-call-suspended": {
          streamedToolCallArgs.delete(chunk.payload.toolCallId);
          // Always discard the pending tool-call: if it matches, the tool
          // was suspended before execution; if it doesn't match, the pending
          // call is orphaned (never executed) so emitting TOOL_CALL_START/
          // ARGS/END without a TOOL_CALL_RESULT would violate the protocol.
          pendingToolCall = null;
          // Under streamServerToolCalls the call may already be OPEN rather
          // than buffered, and an emitted TOOL_CALL_START cannot be retracted —
          // close it so the suspend does not leave a start without a terminal.
          if (
            chunk.payload.toolCallId &&
            streamedStarted.has(chunk.payload.toolCallId)
          ) {
            endStreamedToolCall(chunk.payload.toolCallId);
          }
          if (!chunk.payload.toolCallId || !chunk.payload.toolName) {
            callbacks.onError(
              new Error(
                `Malformed ${chunk.type}: missing toolCallId or toolName in payload`,
              ),
            );
            return true;
          }
          // The turn interrupts here — no `finish` will release the buffer, so
          // emit any assistant text streamed before the suspend (raw; a suspend
          // carries no processor uiMessages) ahead of the interrupt event.
          flushBufferedTextRaw();
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
            ...(chunk.type === "tool-call-approval"
              ? { kind: "approval" as const }
              : {}),
          });
          break;
        }
        // Both "finish" and "step-finish" flush any pending tool call and rotate
        // the messageId so the next step's text gets a fresh ID. When a stream
        // ends with step-finish followed by finish, onFinishMessagePart fires
        // twice — the second rotation produces an unused messageId, which is harmless.
        //
        // For useProcessedFinalText, both release buffered/processed text BEFORE
        // rotating the id (so the emitted text inherits the finishing step's
        // messageId), but only the terminal `finish` may fall back to the raw
        // buffer — see releaseBufferedText.
        case "step-finish": {
          flush();
          releaseBufferedText(chunk.payload, false);
          callbacks.onFinishMessagePart?.();
          break;
        }
        case "finish": {
          flush();
          releaseBufferedText(chunk.payload, true);
          usage = chunk.payload?.output?.usage ?? chunk.payload?.usage;
          callbacks.onFinishMessagePart?.();
          break;
        }
        // Mastra announces the persisted message id for the upcoming step on
        // the start / step-start chunk, before any text streams. Adopt it so
        // the streamed assistant id equals the stored id (see onMessageId).
        case "start":
        case "step-start": {
          // A fresh message window begins: reset the dedup guard so distinct
          // per-step text is never suppressed (see lastEmittedText).
          lastEmittedText = undefined;
          if (chunk.payload?.messageId) {
            adoptMessageId(chunk.payload.messageId);
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
          // The final `tool-call` supplies the authoritative args. Buffered
          // calls are still suppressible, while streamed calls keep
          // their final args separately. Reuse either source for the activity
          // without emitting another tool-call family.
          const args =
            pendingToolCall && pendingToolCall.toolCallId === toolCallId
              ? pendingToolCall.args
              : streamedToolCallArgs.get(toolCallId);
          streamedToolCallArgs.delete(toolCallId);
          pendingToolCall = null;
          // Under streamServerToolCalls the call may already be OPEN rather
          // than buffered (same reasoning as tool-call-suspended above): close
          // it, because the work continues as an activity and no
          // TOOL_CALL_RESULT will follow.
          if (toolCallId && streamedStarted.has(toolCallId)) {
            endStreamedToolCall(toolCallId);
          }
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
        case "tripwire": {
          // A rejected attempt must not be released by a later finish boundary.
          // Text already streamed cannot be retracted, but held text can be dropped.
          bufferedText = "";
          pendingRetryReason = undefined;
          const reason =
            chunk.payload.reason || "The response was blocked by a processor.";
          if (chunk.payload.retry) {
            pendingRetryReason = reason;
          } else {
            flush();
            callbacks.onTextPart?.(reason);
          }
          break;
        }
        case "abort": {
          // @mastra/core emits a first-class `abort` chunk (payload `{}`) when
          // the abortSignal it was given fires, and closes the stream straight
          // after. When that signal is this run's own, the abort listener in
          // run() has already ended the run as cancelled. When it is not (a
          // remote server's run stopped under us), the stream simply ends and
          // the run finishes through the normal path, reported as cancelled.
          // A buffered call that never ran is not surfaced.
          pendingToolCall = null;
          callbacks.onAbort?.();
          break;
        }
        default: {
          warnOnce(chunk.type, "Unrecognized stream chunk type");
          break;
        }
      }
      return false;
    };

    return {
      handleChunk,
      releaseDeferredReplay,
      flush: () => {
        releaseDeferredReplay();
        flush();
        if (pendingRetryReason !== undefined) {
          const reason = pendingRetryReason;
          pendingRetryReason = undefined;
          callbacks.onTextPart?.(reason);
        }
      },
      getUsage: () => usage,
    };
  }

  /**
   * Processes a Mastra fullStream (async iterable) using createChunkProcessor.
   *
   * @returns `"completed"` when the stream ended on its own (the only outcome
   * the caller finishes), `"cancelled"` when the run's signal fired mid-stream,
   * or `"error"` on an error or malformed chunk (already reported through
   * onError).
   */
  private async processFullStream(
    stream: AsyncIterable<any>,
    callbacks: MastraAgentStreamOptions,
    abortSignal: AbortSignal,
    clientToolNames: Set<string> = new Set(),
    initialState: Record<string, any> = {},
    replaySuspendedToolCall?: {
      toolCallId: string;
      // The assistant message in `input.messages` that already holds the call.
      historyMessageId?: string;
    } | null,
  ): Promise<"completed" | "cancelled" | "error"> {
    const { handleChunk, flush, releaseDeferredReplay } =
      this.createChunkProcessor(
        callbacks,
        clientToolNames,
        initialState,
        replaySuspendedToolCall,
      );
    try {
      for await (const chunk of stream) {
        // Cancelled (unsubscribe or abortRun): stop pulling from the source
        // instead of draining it to completion (#2288). Reported distinctly
        // from an error so the caller can tell "stopped on purpose" from
        // "failed". The caller finishes neither: the abort listener in run()
        // has ended a cancelled run, and an error reported itself through
        // onError.
        if (abortSignal.aborted) return "cancelled";
        if (handleChunk(chunk)) return "error";
      }
    } catch (error) {
      // A resumed call already streamed must reach the client before the failure.
      if (!abortSignal.aborted) releaseDeferredReplay();
      throw error;
    }
    flush();
    return "completed";
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
      const storedIds = new Set<string>();
      for (const m of (stored ?? []) as Array<{ id?: string }>) {
        if (!m?.id) continue;
        storedIds.add(m.id);
      }
      if (storedIds.size === 0) return messages; // first turn / empty thread
      // The bridge streams assistant text that follows a tool call under
      // continuation ids derived from the turn's base id — one per text segment
      // (see makeStreamCallbacks). Mastra stores the whole turn under the base
      // id, so no continuation id ever appears in recall. Match the whole family
      // back to its stored base instead, otherwise the split text is re-sent
      // (and duplicated) each turn.
      const isStored = (id: string): boolean => {
        if (storedIds.has(id)) return true;
        const base = MastraAgent.continuationBaseId(id);
        return base !== null && storedIds.has(base);
      };
      // A reasoning message is never stored under its own id: it belongs to
      // the message that follows it (see convertAGUIMessagesToMastra), so it
      // is kept or dropped with that message, below.
      // Developer messages become system instructions and must be supplied on
      // every run, even if their id appears in recalled conversation history.
      const fresh = messages.filter(
        (m) =>
          m.role !== "reasoning" &&
          (m.role === "developer" || !(m.id && isStored(m.id))),
      );
      // Never send an empty turn (a no-op run). If everything was already
      // stored, fall back to forwarding the full list.
      if (fresh.length === 0) return messages;
      const withReasoning = (keep: Set<Message>) =>
        messages.filter((m, index) => {
          if (m.role !== "reasoning") return keep.has(m);
          const owner = messages
            .slice(index + 1)
            .find((next) => next.role !== "reasoning");
          return owner !== undefined && keep.has(owner);
        });

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
      if (neededToolCallIds.size === 0) return withReasoning(freshSet);
      const pairedCalls = messages.filter(
        (m) =>
          !freshSet.has(m) &&
          m.role === "assistant" &&
          (m.toolCalls ?? []).some((tc) => neededToolCallIds.has(tc.id)),
      );
      // Preserve original order so each tool-call precedes its result.
      return withReasoning(new Set([...fresh, ...pairedCalls]));
    } catch (error) {
      // recall() throws for a thread that does not exist yet. That is every
      // first turn, not a failure: nothing is stored, so the full list is the
      // right thing to send. Only warn when the thread exists (or the lookup
      // itself fails).
      if (await this.threadIsMissing(threadId, resourceId)) return messages;
      console.warn(
        `[MastraAgent] Failed to compute new-message diff for thread ${threadId}; sending full history:`,
        error,
      );
      return messages;
    }
  }

  private async threadIsMissing(
    threadId: string,
    resourceId: string,
  ): Promise<boolean> {
    if (!this.isLocalMastraAgent(this.agent)) return false;
    try {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (!memory) return false;
      // Concrete Memory implementations check thread ownership and want the
      // resourceId alongside the threadId; the abstract signature omits it.
      const thread = await memory.getThreadById({
        threadId,
        resourceId,
      } as { threadId: string });
      return thread == null;
    } catch {
      return false;
    }
  }

  /**
   * The shared-state slice of a run's input.state: everything except the
   * `messages` list (which the bridge strips before syncing state to working
   * memory). This is what the client holds as its coagent state, so it is the
   * correct base for the first mid-run STATE_DELTA. Returns `{}` when there is
   * no usable state.
   */
  private workingMemoryStateSlice(
    state: RunAgentInput["state"],
  ): Record<string, any> {
    if (!state || typeof state !== "object") return {};
    const { messages, ...rest } = state as Record<string, any>;
    void messages;
    return rest;
  }

  /**
   * Coerces a working-memory value read back from Mastra (a JSON string for
   * schema/json working memory, or already an object, or a `{ workingMemory }`
   * envelope from the remote HTTP route) into a plain object for merging.
   * Returns `{}` for markdown/non-JSON/template ($schema) values.
   */
  private coerceWorkingMemoryObject(raw: unknown): Record<string, any> {
    let value: unknown = raw;
    if (
      value &&
      typeof value === "object" &&
      "workingMemory" in (value as Record<string, unknown>)
    ) {
      value = (value as Record<string, unknown>).workingMemory;
    }
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return {};
      }
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !("$schema" in (value as Record<string, unknown>))
    ) {
      return value as Record<string, any>;
    }
    return {};
  }

  /**
   * Syncs the run's `input.state` (the client's shared state, minus `messages`)
   * into Mastra's resource-scoped working memory BEFORE streaming, so a UI edit
   * reaches the agent on the next run. Merges the client state over the existing
   * working memory: keys the client doesn't manage are preserved, while its
   * shared-state keys (e.g. `recipe`) overwrite wholesale — so a removed value
   * (an unchecked preference) is actually removed, not left lingering.
   *
   * Working memory lives in the RESOURCE store (default scope "resource"),
   * written via `updateWorkingMemory` — NOT `thread.metadata`, which the model
   * never reads. Local agents write through their own `Memory`; remote agents
   * write through the `MastraClient` (`remoteClient`) so the SAME edit reaches a
   * remote server. No-op when there is no client state or (for remote) no client.
   */
  private async syncInputStateToWorkingMemory(
    input: RunAgentInput,
  ): Promise<void> {
    const rest = this.workingMemoryStateSlice(input.state);
    if (Object.keys(rest).length === 0) return;

    const resourceId = this.resourceId ?? input.threadId;
    const memoryConfig = { workingMemory: { enabled: true } };

    if (this.isLocalMastraAgent(this.agent)) {
      const memory = await this.agent.getMemory({
        requestContext: this.requestContext,
      });
      if (!memory) return;

      let existing: Record<string, any> = {};
      try {
        existing = this.coerceWorkingMemoryObject(
          await memory.getWorkingMemory({
            resourceId,
            threadId: input.threadId,
            memoryConfig,
          }),
        );
      } catch {
        // No/invalid existing working memory — start from the client state.
      }

      const write = () =>
        memory.updateWorkingMemory({
          resourceId,
          threadId: input.threadId,
          workingMemory: JSON.stringify({ ...existing, ...rest }),
          memoryConfig,
        });

      try {
        await write();
      } catch (error) {
        // Thread-scoped working memory lives in thread.metadata, so Mastra
        // refuses the update until the thread exists — and on the first turn
        // it does not yet (the stream creates it). Create it and retry once;
        // anything else is a real failure and still fails the run.
        if (
          await memory.getThreadById({
            threadId: input.threadId,
            resourceId,
          } as { threadId: string })
        ) {
          throw error;
        }
        await memory.createThread({ threadId: input.threadId, resourceId });
        await write();
      }
      return;
    }

    // Remote agent: write through the MastraClient (working-memory HTTP route).
    // Requires the client (set by getRemoteAgents) and the agent id.
    const agentId = this.nativeAgentId ?? this.agentId;
    if (!this.remoteClient || !agentId) return;
    const client = this.remoteClient;

    let existing: Record<string, any> = {};
    try {
      existing = this.coerceWorkingMemoryObject(
        await client.getWorkingMemory({
          agentId,
          threadId: input.threadId,
          resourceId,
        }),
      );
    } catch {
      // No/invalid (or not-yet-created) working memory — start from client state.
    }

    const workingMemory = JSON.stringify({ ...existing, ...rest });
    const write = () =>
      client.updateWorkingMemory({
        agentId,
        threadId: input.threadId,
        resourceId,
        workingMemory,
      });

    try {
      await write();
    } catch {
      // The remote working-memory HTTP route requires the thread to exist. On
      // the first turn it may not yet. So create the thread and retry once.
      // Best-effort: if it still fails, skip rather than fail the run — the
      // stream creates the thread, and later turns will sync.
      try {
        await client.createMemoryThread({
          agentId,
          threadId: input.threadId,
          resourceId,
        } as unknown as Parameters<MastraClient["createMemoryThread"]>[0]);
        await write();
      } catch (error) {
        console.warn(
          `[MastraAgent] Failed to sync input.state to remote working memory for thread ${input.threadId}:`,
          error,
        );
      }
    }
  }

  /**
   * Reads the Mastra execution traceId off a consumed stream response, if any.
   *
   * `traceId` is exposed by Mastra observability v-next on the stream response
   * (`MastraModelOutput.traceId`); it may be a plain string or a Promise that
   * resolves after the stream is consumed, so we await a thenable. Probed
   * structurally so the bridge stays compatible with cores / remote clients
   * that don't expose it (they simply yield undefined). Best-effort: a read
   * that throws is swallowed so it never blocks RUN_FINISHED.
   */
  private async resolveTraceId(response: unknown): Promise<string | undefined> {
    if (!response || typeof response !== "object") return undefined;
    try {
      const raw = (response as { traceId?: unknown }).traceId;
      const traceId =
        raw && typeof (raw as PromiseLike<unknown>).then === "function"
          ? await (raw as PromiseLike<unknown>)
          : raw;
      return typeof traceId === "string" && traceId.length > 0
        ? traceId
        : undefined;
    } catch (error) {
      console.warn("[MastraAgent] Failed to read execution traceId:", error);
      return undefined;
    }
  }

  /**
   * The frontend tools from `RunAgentInput.tools`, in the `clientTools` shape
   * Mastra expects. Shared by the initial `agent.stream(...)` and the resumed
   * `agent.resumeStream(...)` call so a resumed run is offered the same tools
   * as the run it continues (#2667) — without it, an agent that answers only
   * through frontend tools ends the resumed run with nothing on the wire.
   */
  private buildClientTools(tools: RunAgentInput["tools"]): Record<string, any> {
    return (tools ?? []).reduce(
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
  }

  /**
   * Auto-inject the backend-owned `generate_a2ui` tool (pillar 1: easy devex)
   * when the runtime/middleware forwarded `injectA2UITool`. The dev wires NO
   * tool; recovery + subagent ride along. Injected per-run as a server toolset
   * so its execute runs in-process (where the loop lives); the
   * middleware-injected `render_a2ui` client tool is dropped from
   * `clientTools` (mutated in place) so the model calls `generate_a2ui`. Opt
   * out via `injectA2UITool:false`; customize via the `a2ui` config.
   * USER-PREVAILS if the agent already wires `generate_a2ui`. Best-effort: a
   * failure degrades to no A2UI, the turn still runs.
   *
   * LOCAL ONLY — the injected tool carries an in-process `execute`, so it
   * cannot cross the @mastra/client-js wire. Callers gate on
   * `isLocalMastraAgent`.
   *
   * Shared by the initial stream and the resume path, so a resumed run keeps
   * the A2UI toolset the interrupted run had (#2667).
   */
  private async planA2UIToolsets(
    input: RunAgentInput,
    clientTools: Record<string, any>,
    requestContext: RequestContext,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.isLocalMastraAgent(this.agent)) return undefined;
    try {
      const existing = await this.agent.listTools({ requestContext });
      const existingToolNames = [
        ...Object.keys(existing ?? {}),
        ...Object.keys(clientTools),
      ];
      const plan = planA2UIInjection({
        model: this.a2ui?.model ?? (this.agent as { model?: unknown }).model,
        input,
        existingToolNames,
        config: this.a2ui,
      });
      if (!plan) return undefined;
      for (const drop of plan.dropToolNames) delete clientTools[drop];
      return { a2ui: { [plan.toolName]: plan.tool } };
    } catch (error) {
      console.warn(
        "[MastraAgent] A2UI auto-injection skipped (continuing without A2UI):",
        error,
      );
      return undefined;
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
    {
      threadId,
      runId,
      messages,
      tools,
      context: inputContext,
      forwardedProps,
      state,
    }: RunAgentInput,
    callbacks: MastraAgentStreamOptions,
    abortSignal: AbortSignal,
    onClientTools?: (clientTools: Record<string, unknown>) => void,
  ): Promise<void> {
    const { onError, onRunFinished, ...chunkCallbacks } = callbacks;
    const clientTools = this.buildClientTools(tools);
    // Names of the frontend tools — only these stream their args live (see
    // createChunkProcessor). Server tools (on the Mastra agent) are absent here.
    const clientToolNames = new Set<string>(
      tools.map((tool) => tool.name as string),
    );
    // Seed shared-state diffing from the state the client already holds (its
    // coagent state, minus the message list the bridge strips before syncing to
    // working memory). The first mid-run STATE_DELTA then patches from what the
    // UI shows, not from empty. See createChunkProcessor.
    const initialState = this.workingMemoryStateSlice(state);
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
        const a2uiToolsets = await this.planA2UIToolsets(
          {
            forwardedProps,
            context: inputContext,
            messages,
            threadId,
            runId,
            tools,
          } satisfies RunAgentInput,
          clientTools,
          requestContext,
        );
        onClientTools?.(clientTools);

        const streamOptions: Record<string, unknown> = {
          memory: {
            thread: threadId,
            resource: resourceId,
          },
          runId,
          clientTools,
          requestContext,
          ...(a2uiToolsets ? { toolsets: a2uiToolsets } : {}),
          // Cancellation from the run() Observable teardown (#2288). Honoured
          // by @mastra/core, which stops generation and emits an `abort` chunk.
          abortSignal,
        };
        // Pipe the background-task lifecycle into this run's fullStream (and
        // re-enter the loop on completion) when opted in. Only meaningful for
        // local agents with storage + a memory scope; Mastra falls through to
        // the default stream otherwise.
        if (this.untilIdle) {
          streamOptions.untilIdle = this.untilIdle;
        }
        if (this.tracingOptions) {
          streamOptions.tracingOptions = this.tracingOptions;
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
          const outcome = await this.processFullStream(
            response.fullStream,
            { ...chunkCallbacks, onError },
            abortSignal,
            clientToolNames,
            initialState,
          );

          // Cancelled runs are settled by the abort listener in run(); errors
          // have already gone out through onError.
          if (outcome === "completed") {
            const traceId = await this.resolveTraceId(response);
            const usage = await this.resolveUsage(response);
            await onRunFinished?.(traceId, usage);
          }
        } else {
          throw new Error("Invalid response from local agent");
        }
      } catch (error) {
        // A cancelled run can surface as a rejection (an aborted stream), which
        // is not a failure to report.
        if (abortSignal?.aborted) return;
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
          // No `abortSignal` in the stream params: @mastra/client-js Omits it
          // there and reads the fetch signal from construction-time
          // `ClientOptions.abortSignal`, so a per-call signal would only be
          // JSON-serialized into the POST body as `{}`. This run's signal is
          // bound to a per-run handle instead, see remoteAgentForRun.
        };
        if (this.tracingOptions) {
          streamOptions.tracingOptions = this.tracingOptions;
        }
        if (this.headers && Object.keys(this.headers).length > 0) {
          streamOptions.modelSettings = {
            ...((streamOptions.modelSettings as
              | Record<string, unknown>
              | undefined) ?? {}),
            headers: this.headers,
          };
        }
        // Per-run handle so this run's signal reaches the fetch.
        const response = await this.remoteAgentForRun(abortSignal).stream(
          convertedMessages,
          streamOptions,
        );

        // Remote agents use processDataStream (callback-based) — share
        // chunk handling logic via createChunkProcessor.
        if (response && typeof response.processDataStream === "function") {
          const { handleChunk, flush, getUsage } = this.createChunkProcessor(
            { ...chunkCallbacks, onError },
            clientToolNames,
            initialState,
          );

          await response.processDataStream({
            onChunk: async (chunk: any) => {
              if (stopped) return;
              // Cancelled (unsubscribe or abortRun): stop consuming (#2288).
              // The per-run handle also aborts the underlying fetch, so the
              // server stops producing rather than just going unread.
              if (abortSignal.aborted) {
                stopped = true;
                return;
              }
              if (handleChunk(chunk)) stopped = true;
            },
          });
          if (!stopped) {
            flush();
            const traceId = await this.resolveTraceId(response);
            const usage = await this.resolveUsage(response, getUsage());
            await onRunFinished?.(traceId, usage);
          }
        } else {
          throw new Error("Invalid response from remote agent");
        }
      } catch (error) {
        // Aborting the fetch rejects here. That is a cancellation, not a
        // failure: the run is settled by the abort listener in run().
        if (abortSignal.aborted) return;
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
