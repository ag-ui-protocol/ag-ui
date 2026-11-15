import type {
  BaseEvent,
  Interrupt,
  Message,
  ReasoningEndEvent,
  ReasoningMessageEndEvent,
  SubagentErrorEvent,
  SubagentFinishedEvent,
  SubagentStartedEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
} from "@ag-ui/client";
import { EventType, randomUUID } from "@ag-ui/client";
import { toolErrorMessage } from "./tool-results";

/**
 * How delegated sub-agent work reaches the AG-UI stream.
 *
 * - `"hidden"` (default): the client sees the delegating tool call and its
 *   result, and nothing of the sub-agent's own stream. This is what the bridge
 *   has always done.
 * - `"attributed"`: each delegation becomes an AG-UI subagent invocation
 *   (`SUBAGENT_STARTED` / `SUBAGENT_FINISHED` / `SUBAGENT_ERROR`), and the
 *   sub-agent's text, reasoning and tool calls stream live, tagged with its
 *   `subagentRunId`. Needs an AG-UI 1.0 client.
 */
export type MastraSubagentVisibility = "hidden" | "attributed";

/**
 * What an attributed sub-agent's own tool results carry.
 *
 * - `"full"` (default): the result, as for the agent's own tools.
 * - `"omit"`: an empty result. Each call still gets its TOOL_CALL_RESULT, so a
 *   client can tell a finished call from a running one, and a failed call keeps
 *   its error. The delegation's own result is never omitted.
 */
export type MastraSubagentToolResults = "full" | "omit";

/**
 * Mastra exposes each sub-agent of a supervisor to its model as a tool named
 * `agent-<key>`, and identifies a delegated stream by that name together with
 * a wrapped chunk whose `from` is `AGENT`.
 */
const DELEGATION_TOOL_PREFIX = "agent-";

/** Whether `toolName` is one of Mastra's delegation tools (`agent-<key>`). */
export function isDelegationTool(toolName: unknown): toolName is string {
  return (
    typeof toolName === "string" &&
    toolName.startsWith(DELEGATION_TOOL_PREFIX) &&
    toolName.length > DELEGATION_TOOL_PREFIX.length
  );
}

// Every `from` Mastra stamps on a stream chunk (`ChunkFrom`).
const CHUNK_SOURCES = new Set([
  "AGENT",
  "USER",
  "SYSTEM",
  "WORKFLOW",
  "NETWORK",
]);

// Nested agents deeper than this get no description; delegation still works.
const MAX_DIRECTORY_DEPTH = 3;

/** `SUBAGENT_ERROR.code` values the bridge emits. */
export const SUBAGENT_ERROR_CODES = {
  /** The sub-agent failed: its model errored, or the delegation tool did. */
  failed: "MASTRA_SUBAGENT_ERROR",
  /** A processor of the sub-agent blocked it (a tripwire). */
  tripwire: "MASTRA_TRIPWIRE",
  /** The run stopped, or the sub-agent was aborted, before it finished. */
  cancelled: "CANCELLED",
} as const;

const NO_TOOL_RESULT = "The tool call ended without a result.";
const DEFAULT_TRIPWIRE_REASON = "The response was blocked by a processor.";
const CANCELLED_MESSAGE = "The run stopped before the sub-agent finished.";
const ABORTED_MESSAGE = "The sub-agent run was aborted.";

type UnknownRecord = Record<string, any>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Where an event goes out: the run's lifecycle, or a lane's sink. */
export interface EventSink {
  next(event: BaseEvent): void;
  /** Registers what closes the stream's open reasoning message. */
  setReasoningCloser(close: () => void): void;
}

/** The processor that maps one sub-agent's chunks, as the bridge builds it. */
export interface LaneProcessor {
  handleChunk(chunk: unknown): boolean;
  flush(): void;
}

/** A `tool-output` payload that carries a delegated sub-agent's chunk. */
export interface DelegationWrapper {
  toolCallId: string;
  toolName: string;
  output: UnknownRecord;
}

/**
 * The delegations a chunk processor can see: the supervisor's own, or those a
 * sub-agent makes in turn. Each processor holds one.
 */
export interface DelegationScope {
  /**
   * The delegation a `tool-output` payload carries, or undefined when it is
   * none (a plain tool's or a workflow's output). Unknown shapes warn once.
   */
  match(payload: unknown): DelegationWrapper | undefined;
  /** Hands a delegated chunk to its invocation, announcing the invocation first. */
  deliver(wrapper: DelegationWrapper): void;
  /**
   * The delegating call has its result, or `failure` when it failed: ends the
   * invocation the call started, if any.
   */
  complete(toolCallId: string, failure?: string): void;
}

/** How the run ended, which decides how invocations still open end. */
export type SubagentRunEnding =
  | { type: "finished" }
  | { type: "suspended"; interrupts: readonly Interrupt[] }
  | { type: "cancelled" }
  | { type: "failed"; message: string };

type LaneClosing =
  | SubagentRunEnding
  | { type: "result" }
  | { type: "failure"; message: string };

export interface SubagentDirectoryEntry {
  description?: string;
  /** The sub-agent's model, when it exposes one (labels its token usage). */
  provider?: string;
  model?: string;
  children: SubagentDirectory;
}

/** A supervisor's sub-agents by key, with their own sub-agents. */
export type SubagentDirectory = Map<string, SubagentDirectoryEntry>;

function readDescription(agent: unknown): string | undefined {
  if (!isRecord(agent)) return undefined;
  let description: unknown;
  try {
    description =
      typeof agent.getDescription === "function"
        ? agent.getDescription()
        : agent.description;
  } catch {
    return undefined;
  }
  return typeof description === "string" && description.length > 0
    ? description
    : undefined;
}

/**
 * A local agent's provider and model id, when its configured model exposes
 * them (a model given as a string or a function does not).
 */
export function modelIdentityOf(agent: unknown): {
  provider?: string;
  model?: string;
} {
  const model = isRecord(agent) ? agent.model : undefined;
  if (!isRecord(model)) return {};
  return {
    ...(typeof model.provider === "string" ? { provider: model.provider } : {}),
    ...(typeof model.modelId === "string" ? { model: model.modelId } : {}),
  };
}

/**
 * Reads a local agent's sub-agents (`listAgents`), their descriptions and
 * models, recursively up to `maxDepth` levels. An agent without sub-agents yields an
 * empty directory. Throws what `listAgents` throws.
 */
export async function loadSubagentDirectory(
  agent: unknown,
  requestContext: unknown,
  maxDepth = MAX_DIRECTORY_DEPTH,
  ancestors: readonly unknown[] = [],
): Promise<SubagentDirectory> {
  const directory: SubagentDirectory = new Map();
  if (maxDepth <= 0 || !isRecord(agent) || ancestors.includes(agent)) {
    return directory;
  }
  const listAgents = agent.listAgents;
  if (typeof listAgents !== "function") return directory;
  const agents: unknown = await listAgents.call(agent, { requestContext });
  if (!isRecord(agents)) return directory;
  for (const [key, subagent] of Object.entries(agents)) {
    const description = readDescription(subagent);
    directory.set(key, {
      ...(description ? { description } : {}),
      ...modelIdentityOf(subagent),
      children: await loadSubagentDirectory(
        subagent,
        requestContext,
        maxDepth - 1,
        [...ancestors, agent],
      ),
    });
  }
  return directory;
}

/** One sub-agent run's token usage, by its path of delegation names (`["mid", "leaf"]`). */
export interface DelegatedUsage {
  path: string[];
  usage: unknown;
}

/**
 * The usage of every sub-agent run a delegating call's output carries, in
 * either visibility. Mastra forwards a delegated agent's chunks wrapped once
 * per level of delegation, and each agent's `finish` reports only its own
 * model calls, not those of the agents it delegated to. A run ends in one
 * `finish`; `step-finish` repeats the running total, so only `finish` counts.
 * Workflows and plain tool writers are not sub-agents and are skipped.
 */
export function delegatedUsage(
  payload: unknown,
  path: readonly string[] = [],
): DelegatedUsage[] {
  if (!isRecord(payload)) return [];
  const { output, toolName } = payload;
  if (!isRecord(output) || typeof output.type !== "string") return [];
  if (!isDelegationTool(toolName)) return [];
  const here = [...path, toolName.slice(DELEGATION_TOOL_PREFIX.length)];
  if (output.type === "tool-output")
    return delegatedUsage(output.payload, here);
  if (output.type !== "finish" || output.from !== "AGENT") return [];
  const result = isRecord(output.payload) ? output.payload.output : undefined;
  const usage = isRecord(result) ? result.usage : undefined;
  return usage === undefined ? [] : [{ path: here, usage }];
}

/** The directory entry of a sub-agent by its path of delegation names. */
export function subagentAt(
  directory: SubagentDirectory,
  path: readonly string[],
): SubagentDirectoryEntry | undefined {
  let entry: SubagentDirectoryEntry | undefined;
  let level = directory;
  for (const name of path) {
    entry = level.get(name);
    if (!entry) return undefined;
    level = entry.children;
  }
  return entry;
}

/**
 * The client's history without what sub-agents produced: messages attributed
 * to a sub-agent (`subagentRunId`), and tool messages answering their calls,
 * which can arrive untagged (CopilotKit's stop finalizer answers open calls
 * without attribution). A supervisor never sees a sub-agent's work as its own
 * history; the delegation result already carries what it needs. Returns the
 * same array when nothing is attributed.
 */
export function withoutSubagentMessages(messages: Message[]): Message[] {
  const subagentCalls = new Set<string>();
  let attributed = false;
  for (const message of messages) {
    if (message.subagentRunId == null) continue;
    attributed = true;
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) subagentCalls.add(call.id);
    }
  }
  if (!attributed) return messages;
  return messages.filter(
    (message) =>
      message.subagentRunId == null &&
      !(message.role === "tool" && subagentCalls.has(message.toolCallId)),
  );
}

/**
 * The events of one sub-agent invocation, as they go out: every id the
 * sub-agent's processor uses is namespaced under the invocation
 * (`<subagentRunId>/<id>`), so ids repeated across agents (providers and mocks
 * reuse `call-1`) never merge on the client, and every event carries the
 * invocation's `subagentRunId`. It records what the invocation opened so that
 * its end can close it first.
 */
export class LaneSink implements EventSink {
  private readonly openReasoningMessages = new Set<string>();
  private readonly openReasoningSpans = new Set<string>();
  private readonly openToolCalls = new Set<string>();
  private readonly startedCalls = new Set<string>();
  private readonly answeredCalls = new Set<string>();
  private closeReasoning?: () => void;

  constructor(
    private readonly lane: SubagentLane,
    private readonly emit: (event: BaseEvent) => void,
    private readonly omitToolResults: boolean,
  ) {}

  setReasoningCloser(close: () => void): void {
    this.closeReasoning = close;
  }

  readonly next = (event: BaseEvent): void => {
    const attributed = this.attribute(event);
    if (attributed) this.forward(attributed);
  };

  private namespaced(id: string): string {
    return `${this.lane.id}/${id}`;
  }

  private attribute(event: BaseEvent): BaseEvent | undefined {
    const source = event as BaseEvent & UnknownRecord;
    const tag = { subagentRunId: this.lane.id };
    switch (event.type) {
      // A sub-agent's messages never go back to Mastra (see
      // withoutSubagentMessages), so its provider reasoning artefacts have no
      // use, and its working memory is not the run's shared state.
      case EventType.REASONING_ENCRYPTED_VALUE:
      case EventType.STATE_SNAPSHOT:
      case EventType.STATE_DELTA:
        return undefined;
      case EventType.TOOL_CALL_START:
        return {
          ...source,
          toolCallId: this.namespaced(source.toolCallId),
          ...(typeof source.parentMessageId === "string"
            ? { parentMessageId: this.namespaced(source.parentMessageId) }
            : {}),
          ...tag,
        } as BaseEvent;
      case EventType.TOOL_CALL_ARGS:
      case EventType.TOOL_CALL_END:
        return {
          ...source,
          toolCallId: this.namespaced(source.toolCallId),
          ...tag,
        } as BaseEvent;
      case EventType.TOOL_CALL_RESULT: {
        const omit =
          this.omitToolResults && !this.lane.failedCalls.has(source.toolCallId);
        return {
          ...source,
          toolCallId: this.namespaced(source.toolCallId),
          messageId: this.namespaced(source.messageId),
          ...(omit ? { content: "" } : {}),
          ...tag,
        } as BaseEvent;
      }
      default:
        // Text, reasoning and activity events, all keyed by messageId.
        return {
          ...source,
          ...(typeof source.messageId === "string"
            ? { messageId: this.namespaced(source.messageId) }
            : {}),
          ...tag,
        } as BaseEvent;
    }
  }

  private forward(event: BaseEvent): void {
    const { messageId, toolCallId } = event as UnknownRecord;
    switch (event.type) {
      case EventType.REASONING_START:
        this.openReasoningSpans.add(messageId);
        break;
      case EventType.REASONING_END:
        this.openReasoningSpans.delete(messageId);
        break;
      case EventType.REASONING_MESSAGE_START:
        this.openReasoningMessages.add(messageId);
        break;
      case EventType.REASONING_MESSAGE_END:
        this.openReasoningMessages.delete(messageId);
        break;
      case EventType.TOOL_CALL_START:
        this.openToolCalls.add(toolCallId);
        this.startedCalls.add(toolCallId);
        break;
      case EventType.TOOL_CALL_END:
        this.openToolCalls.delete(toolCallId);
        break;
      case EventType.TOOL_CALL_RESULT:
        this.answeredCalls.add(toolCallId);
        break;
    }
    this.emit(event);
  }

  /** Closes the invocation's open reasoning and tool calls. */
  closeOpen(): void {
    this.closeReasoning?.();
    const tag = { subagentRunId: this.lane.id };
    for (const messageId of [...this.openReasoningMessages]) {
      this.forward({
        type: EventType.REASONING_MESSAGE_END,
        messageId,
        ...tag,
      } as ReasoningMessageEndEvent);
    }
    for (const messageId of [...this.openReasoningSpans]) {
      this.forward({
        type: EventType.REASONING_END,
        messageId,
        ...tag,
      } as ReasoningEndEvent);
    }
    for (const toolCallId of [...this.openToolCalls]) {
      this.forward({
        type: EventType.TOOL_CALL_END,
        toolCallId,
        ...tag,
      } as ToolCallEndEvent);
    }
  }

  /**
   * Answers every call the invocation started and left unanswered. A client
   * treats a call with no result as pending, and CopilotKit hands a pending
   * call to a matching (or wildcard) frontend tool.
   */
  answerOpenCalls(): void {
    for (const toolCallId of this.startedCalls) {
      if (this.answeredCalls.has(toolCallId)) continue;
      this.forward({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId,
        content: NO_TOOL_RESULT,
        messageId: this.namespaced(randomUUID()),
        role: "tool",
        subagentRunId: this.lane.id,
      } as ToolCallResultEvent);
    }
  }
}

/** One delegation invocation and the state its end is decided from. */
export class SubagentLane {
  readonly sink: LaneSink;
  /** The delegations this sub-agent makes in turn. */
  readonly scope: DelegationScope;
  /**
   * The lane's current native message id, read and advanced by its stream
   * callbacks like the run's own. Minted until the sub-agent announces one.
   */
  messageId = randomUUID();
  processor!: LaneProcessor;
  /** Native ids of the sub-agent's calls that failed (`tool-error`). */
  readonly failedCalls = new Set<string>();
  /** A tool of this sub-agent paused for approval or suspended. */
  suspended = false;
  aborted = false;
  error?: string;
  tripwire?: string;

  constructor(
    private readonly tracker: SubagentTracker,
    readonly id: string,
    readonly name: string,
    /** The delegating call, namespaced like the client holds it. */
    readonly callKey: string,
    readonly parent: SubagentLane | undefined,
    readonly children: SubagentDirectory,
    emit: (event: BaseEvent) => void,
    omitToolResults: boolean,
  ) {
    this.sink = new LaneSink(this, emit, omitToolResults);
    this.scope = tracker.scopeFor(this);
  }

  get depth(): number {
    return this.parent ? this.parent.depth + 1 : 0;
  }

  /** Every lane processor shares the run's warnings, so each warns once. */
  get warnedChunkTypes(): Set<string> {
    return this.tracker.warnedChunkTypes;
  }

  isWithin(ancestor: SubagentLane): boolean {
    for (let lane = this.parent; lane; lane = lane.parent) {
      if (lane === ancestor) return true;
    }
    return false;
  }

  markSuspended(): void {
    this.suspended = true;
  }

  markAborted(): void {
    this.aborted = true;
  }

  recordError(message: string): void {
    this.error ??= message;
  }

  /**
   * Maps one of the sub-agent's chunks. A sub-agent's failure is its own: an
   * `error` or a blocking `tripwire` is recorded for its end and never fails
   * the run, and only the error's message is kept, never its stack.
   */
  receive(chunk: UnknownRecord): void {
    const payload = isRecord(chunk.payload) ? chunk.payload : undefined;
    switch (chunk.type) {
      case "error":
        this.recordError(toolErrorMessage(payload?.error));
        return;
      case "tripwire":
        if (!payload?.retry) {
          this.tripwire ??=
            typeof payload?.reason === "string" && payload.reason
              ? payload.reason
              : DEFAULT_TRIPWIRE_REASON;
          return;
        }
        break;
      case "tool-error":
        if (typeof payload?.toolCallId === "string") {
          this.failedCalls.add(payload.toolCallId);
        }
        break;
    }
    this.processor.handleChunk(chunk);
  }
}

export interface SubagentTrackerOptions {
  /** Sends an event out through the run. */
  emit(event: BaseEvent): void;
  /** The message holding a call, as the client sees it, if known. */
  parentMessageIdOf(toolCallId: string): string | undefined;
  /** Builds the processor that maps a new invocation's chunks. */
  createProcessor(lane: SubagentLane): LaneProcessor;
  toolResults?: MastraSubagentToolResults;
}

/**
 * The sub-agent invocations of one run (`subagentVisibility: "attributed"`).
 *
 * Mastra forwards each chunk a delegated sub-agent streams as a `tool-output`
 * of the delegating call, verbatim and with `from: "AGENT"`; a nested
 * delegation is wrapped once more. Each delegating call that streams becomes
 * one invocation with its own lane (a processor of its own), so concurrent
 * delegations interleave without touching each other. An invocation ends when
 * its delegating call gets its result, or when the run ends.
 *
 * `subagentRunId` is the delegating call's id, prefixed by its ancestors' ids
 * when nested (`D1/d9`). It is deterministic, so the run that resumes a
 * suspended invocation announces the same id again.
 */
export class SubagentTracker {
  /** Open invocations by delegating call, in the order they started. */
  private readonly open = new Map<string, SubagentLane>();
  private readonly usedIds = new Set<string>();
  private readonly warnedShapes = new Set<string>();
  private directory: SubagentDirectory = new Map();
  readonly warnedChunkTypes = new Set<string>();
  /** The supervisor's own delegations. */
  readonly root: DelegationScope;

  constructor(private readonly options: SubagentTrackerOptions) {
    this.root = this.scopeFor(undefined);
  }

  /** Sub-agent names and descriptions, for SUBAGENT_STARTED. */
  setDirectory(directory: SubagentDirectory): void {
    this.directory = directory;
  }

  scopeFor(parent: SubagentLane | undefined): DelegationScope {
    const prefix = parent ? `${parent.id}/` : "";
    return {
      match: (payload) => this.match(payload, prefix),
      deliver: (wrapper) => {
        const callKey = prefix + wrapper.toolCallId;
        const lane =
          this.open.get(callKey) ??
          this.start(callKey, wrapper.toolName, parent);
        lane.receive(wrapper.output);
      },
      complete: (toolCallId, failure) => {
        const lane = this.open.get(prefix + toolCallId);
        if (!lane) return;
        this.close(
          lane,
          failure === undefined
            ? { type: "result" }
            : { type: "failure", message: failure },
        );
      },
    };
  }

  /**
   * The invocation a pause of the supervisor's call `toolCallId` comes from:
   * the deepest open invocation under it whose own tool paused, else the
   * invocation the call started.
   */
  suspensionOrigin(toolCallId: string): string | undefined {
    const lane = this.open.get(toolCallId);
    if (!lane) return undefined;
    let origin = lane;
    for (const candidate of this.open.values()) {
      if (
        candidate.suspended &&
        candidate.isWithin(lane) &&
        (!origin.suspended || candidate.depth > origin.depth)
      ) {
        origin = candidate;
      }
    }
    return origin.id;
  }

  /** Ends every invocation still open, deepest first, as the run ended. */
  closeAll(ending: SubagentRunEnding): void {
    const lanes = [...this.open.values()].sort((a, b) => b.depth - a.depth);
    for (const lane of lanes) this.close(lane, ending);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnedShapes.has(key)) return;
    this.warnedShapes.add(key);
    console.warn(`[MastraAgent] ${message}`);
  }

  /**
   * Mastra marks the chunks a delegated agent streams `from: "AGENT"`, except
   * the agent's own tool output (including a nested delegation's), which is
   * `from: "USER"` like any tool writer's. So `AGENT` is what starts an
   * invocation, and once one is open every chunk of its stream belongs to it.
   */
  private match(
    payload: unknown,
    prefix: string,
  ): DelegationWrapper | undefined {
    if (!isRecord(payload)) return undefined;
    const { output, toolCallId, toolName } = payload;
    // A plain tool's writer output is a raw value, not a stream chunk.
    if (!isRecord(output) || typeof output.type !== "string") return undefined;
    if (!("from" in output)) return undefined;
    if (
      typeof toolCallId === "string" &&
      typeof toolName === "string" &&
      this.open.has(prefix + toolCallId)
    ) {
      return { toolCallId, toolName, output };
    }
    const from: unknown = output.from;
    if (from !== "AGENT") {
      // Workflows (and networks) forward their own chunk types; they are not
      // mapped to sub-agents.
      if (typeof from !== "string" || !CHUNK_SOURCES.has(from)) {
        this.warnOnce(
          `from:${String(from)}`,
          `Ignoring tool output from an unrecognized source (from=${String(from)}); it is not attributed to a sub-agent`,
        );
      }
      return undefined;
    }
    if (!isDelegationTool(toolName)) {
      this.warnOnce(
        `tool:${String(toolName)}`,
        `Not attributing agent output forwarded by tool ${String(toolName)}: only Mastra delegation tools (agent-<name>) map to sub-agents`,
      );
      return undefined;
    }
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      this.warnOnce(
        `call:${toolName}`,
        `Dropping delegated output of ${toolName} without a toolCallId`,
      );
      return undefined;
    }
    return { toolCallId, toolName, output };
  }

  private uniqueId(callKey: string): string {
    let id = callKey;
    for (let n = 2; this.usedIds.has(id); n++) id = `${callKey}#${n}`;
    this.usedIds.add(id);
    return id;
  }

  private start(
    callKey: string,
    toolName: string,
    parent: SubagentLane | undefined,
  ): SubagentLane {
    const id = this.uniqueId(callKey);
    const name = toolName.slice(DELEGATION_TOOL_PREFIX.length);
    const entry = (parent ? parent.children : this.directory).get(name);
    const parentMessageId = this.options.parentMessageIdOf(callKey);
    const lane = new SubagentLane(
      this,
      id,
      name,
      callKey,
      parent,
      entry?.children ?? new Map(),
      this.options.emit,
      this.options.toolResults === "omit",
    );
    this.options.emit({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: id,
      name,
      ...(entry?.description ? { description: entry.description } : {}),
      ...(parent ? { parentSubagentRunId: parent.id } : {}),
      parentToolCallId: callKey,
      ...(parentMessageId ? { parentMessageId } : {}),
    } as SubagentStartedEvent);
    lane.processor = this.options.createProcessor(lane);
    this.open.set(callKey, lane);
    return lane;
  }

  private close(lane: SubagentLane, closing: LaneClosing): void {
    if (this.open.get(lane.callKey) !== lane) return;
    // An invocation never ends while one it spawned is still open.
    const descendants = [...this.open.values()]
      .filter((candidate) => candidate.isWithin(lane))
      .sort((a, b) => b.depth - a.depth);
    const inherited: LaneClosing =
      closing.type === "result" ? { type: "finished" } : closing;
    for (const descendant of descendants) this.close(descendant, inherited);
    this.open.delete(lane.callKey);
    // A cancelled or suspended invocation stops where it is. Anything else
    // first releases what its processor still holds, and answers its calls.
    const settled =
      closing.type !== "cancelled" &&
      closing.type !== "suspended" &&
      closing.type !== "failed";
    if (settled) lane.processor.flush();
    lane.sink.closeOpen();
    if (settled) lane.sink.answerOpenCalls();
    this.options.emit(this.terminalEvent(lane, closing));
  }

  private terminalEvent(lane: SubagentLane, closing: LaneClosing): BaseEvent {
    const error = (message: string, code?: string) =>
      ({
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: lane.id,
        message,
        ...(code ? { code } : {}),
      }) as SubagentErrorEvent;
    switch (closing.type) {
      case "suspended": {
        const interruptIds = closing.interrupts
          .filter((interrupt) => interrupt.subagentRunId === lane.id)
          .map((interrupt) => interrupt.id);
        return {
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: lane.id,
          outcome: {
            type: "suspended",
            ...(interruptIds.length > 0 ? { interruptIds } : {}),
          },
        } as SubagentFinishedEvent;
      }
      case "cancelled":
        return error(CANCELLED_MESSAGE, SUBAGENT_ERROR_CODES.cancelled);
      case "failed":
        // The run itself failed; its RUN_ERROR follows.
        return error(closing.message);
      case "failure":
        return error(
          lane.error ?? closing.message,
          SUBAGENT_ERROR_CODES.failed,
        );
      case "result":
      case "finished":
        if (lane.tripwire !== undefined) {
          return error(lane.tripwire, SUBAGENT_ERROR_CODES.tripwire);
        }
        if (lane.error !== undefined) {
          return error(lane.error, SUBAGENT_ERROR_CODES.failed);
        }
        if (lane.aborted) {
          return error(ABORTED_MESSAGE, SUBAGENT_ERROR_CODES.cancelled);
        }
        return {
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: lane.id,
        } as SubagentFinishedEvent;
    }
  }
}
