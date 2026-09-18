import { EventType, RunAgentInputSchema, type BaseEvent, type RunAgentInput, type ToolMessage } from "@ag-ui/core";
import { AbstractAgent, type AgentConfig } from "@ag-ui/client";
import type { CopilotSession, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import { Observable } from "rxjs";
import { createHash } from "node:crypto";
import { CopilotEventMapper } from "./mapper.js";

export type CopilotSessionPort = Pick<CopilotSession, "sessionId" | "send" | "abort" | "disconnect"> & {
  rpc: { tools: Pick<CopilotSession["rpc"]["tools"], "handlePendingToolCall"> };
};
export interface CopilotClientPort {
  createSession(config: SessionConfig): Promise<CopilotSessionPort>;
}
export interface StateBridge {
  initial: unknown;
  /** Return validated state; reject stale input instead of silently overwriting it. */
  accept(input: unknown, current: unknown): unknown;
  prompt?(state: unknown): string;
}
export interface ToolContext {
  getState(): unknown;
  setState(state: unknown, delta: unknown[]): void;
  /** App-owned activity, not a fabricated native SDK event. */
  emitActivity(messageId: string, activityType: string, content: Record<string, unknown>): void;
  signal: AbortSignal;
}
export interface CopilotAdapterOptions {
  client: CopilotClientPort;
  model?: string;
  sessionConfig?: Omit<SessionConfig, "onEvent" | "tools" | "sessionId">;
  tools?: (context: ToolContext) => Tool[];
  state?: StateBridge;
  maxThreads?: number;
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  maxOutputBytes?: number;
  maxEvents?: number;
  maxPendingTools?: number;
  maxTurnsPerThread?: number;
  runTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class CopilotAdapterError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code?: string) {
    super(message);
    this.name = "CopilotAdapterError";
  }
}

/** Bounded producer/consumer queue; failure wakes readers instead of leaking a pending next(). */
class EventQueue {
  private events: { event: BaseEvent; bytes: number }[] = [];
  private bytes = 0;
  private wake?: () => void;
  private ended = false;
  constructor(private maxEvents: number, private maxBytes: number) {}
  push(event: BaseEvent): void {
    if (this.ended) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.events.length >= this.maxEvents || this.bytes + bytes > this.maxBytes) {
      throw new Error("Event queue limit exceeded");
    }
    this.events.push({ event, bytes });
    this.bytes += bytes;
    this.wake?.();
  }
  end(): void { this.ended = true; this.wake?.(); }
  fail(events: BaseEvent[]): void {
    // On overflow prioritize the terminal; never replace a bounded queue with every orphan closure.
    this.events = events.slice(-1).map((event) => ({ event, bytes: 0 }));
    this.bytes = 0;
    this.end();
  }
  async next(): Promise<BaseEvent | undefined> {
    while (!this.events.length && !this.ended) {
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
    const value = this.events.shift();
    if (value) this.bytes -= value.bytes;
    return value?.event;
  }
}

type ToolMetadata = { toolName: string; arguments: unknown; agentId?: string; parentToolCallId?: string };
type Pending = ToolMetadata & { requestId: string };
type ChildStarted = Extract<SessionEvent, { type: "subagent.started" }>;
type Entry = {
  session?: CopilotSessionPort;
  state: unknown;
  active: boolean;
  lastUsed: number;
  turnIds: Set<string>;
  toolDefinitions: string;
  frontendNames: Set<string>;
  backendNames: Set<string>;
  pending: Map<string, Pending>;
  pendingAnswers: Map<string, ToolMessage>;
  outstanding: Set<string>;
  backendResults: Map<string, string>;
  answeredResults: Map<string, string>;
  answeredRequests: Map<string, string>;
  requestCalls: Map<string, string>;
  toolMetadata: Map<string, ToolMetadata>;
  childStarts: Map<string, ChildStarted>;
  onEvent?: (event: SessionEvent) => void;
  emit?: (event: BaseEvent) => void;
  lifetime: AbortController;
  cancel?: () => void;
  poisoned: boolean;
  disposal?: Promise<void>;
};

/** One native session per thread. This registry is process-local, not durable recovery. */
export class CopilotAdapter {
  private readonly entries = new Map<string, Entry>();
  private readonly activeThreads = new Set<string>();
  private closed = false;
  private readonly limits;
  constructor(private readonly options: CopilotAdapterOptions) {
    this.limits = {
      threads: options.maxThreads ?? 32, queueEvents: options.maxQueueEvents ?? 1024,
      queueBytes: options.maxQueueBytes ?? 1024 * 1024, output: options.maxOutputBytes ?? 64 * 1024,
      events: options.maxEvents ?? 20_000, pending: options.maxPendingTools ?? 32,
      turns: options.maxTurnsPerThread ?? 512, timeout: options.runTimeoutMs ?? 120_000,
      idle: options.idleTimeoutMs ?? 15 * 60_000,
    };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Adapter limits must be positive integers");
    }
  }

  private async dispose(threadId: string, entry: Entry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    entry.poisoned = true;
    entry.lifetime.abort();
    entry.onEvent = undefined;
    entry.emit = undefined;
    entry.pending.clear();
    entry.pendingAnswers.clear();
    entry.requestCalls.clear();
    entry.outstanding.clear();
    entry.toolMetadata.clear();
    entry.childStarts.clear();
    if (this.entries.get(threadId) === entry) this.entries.delete(threadId);
    entry.disposal = (async () => {
      if (entry.session) {
        try { await entry.session.abort(); } catch { /* Disconnect still releases native listeners. */ }
        await entry.session.disconnect();
      }
    })();
    return entry.disposal;
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries];
    for (const [, entry] of entries) entry.cancel?.();
    await Promise.allSettled(entries.map(([id, entry]) => this.dispose(id, entry)));
  }

  /** Explicit Stop, including a session parked after its successful SSE handoff. */
  async cancelThread(threadId: string): Promise<boolean> {
    if (!threadId || threadId.length > 256) throw new CopilotAdapterError("Invalid thread ID");
    const entry = this.entries.get(threadId);
    if (!entry) return false;
    entry.cancel?.();
    await this.dispose(threadId, entry);
    return true;
  }

  async *stream(rawInput: RunAgentInput, options: { signal?: AbortSignal } = {}): AsyncGenerator<BaseEvent> {
    const parsed = RunAgentInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new CopilotAdapterError("Invalid AG-UI RunAgentInput");
    const input = parsed.data;
    if (!input.threadId || !input.runId || input.threadId.length > 256 || input.runId.length > 256) {
      throw new CopilotAdapterError("Thread and run IDs must contain 1–256 characters");
    }
    if (this.closed) throw new CopilotAdapterError("Adapter is closed", 503);
    if (options.signal?.aborted) throw new CopilotAdapterError("Run cancelled", 499);
    if (this.activeThreads.has(input.threadId)) throw new CopilotAdapterError("Thread already has an active run", 409);
    this.activeThreads.add(input.threadId);
    try {
    let entry = this.entries.get(input.threadId);
    if (entry?.active) throw new CopilotAdapterError("Thread already has an active run", 409);
    if (entry && Date.now() - entry.lastUsed > this.limits.idle) {
      await this.dispose(input.threadId, entry);
      entry = undefined;
    }
    const digest = (content: string) => createHash("sha256").update(content).digest("hex");
    const answerDigest = (result: ToolMessage) => digest(JSON.stringify([result.content, result.error ?? null]));
    const results: ToolMessage[] = [];
    let replayed = false;
    let conflict = false;
    // CopilotKit sends the complete transcript, not just the most recent result.
    for (const result of input.messages) {
      if (result.role !== "tool") continue;
      if (Buffer.byteLength(result.content) + Buffer.byteLength(result.error ?? "") > this.limits.output) throw new CopilotAdapterError("Tool result limit exceeded", 413);
      if (entry?.backendResults.get(result.toolCallId) === digest(result.content)) continue;
      const accepted = entry?.pendingAnswers.get(result.toolCallId);
      const answered = entry?.answeredResults.get(result.toolCallId) ?? (accepted ? answerDigest(accepted) : undefined);
      if (answered !== undefined) {
        if (answered !== answerDigest(result)) conflict = true;
        else replayed = true;
      } else {
        results.push(result);
      }
    }
    if (conflict) {
      yield { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId };
      yield { type: EventType.RUN_ERROR, code: "FRONTEND_TOOL_RESULT_CONFLICT", message: "A different answer was supplied for an already answered frontend tool" };
      return;
    }
    const user = [...input.messages].reverse().find((m) => m.role === "user");
    const newUser = user !== undefined && !entry?.turnIds.has(user.id);
    if (replayed && !results.length && !newUser) {
      entry!.lastUsed = Date.now();
      yield { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId };
      yield { type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId };
      return;
    }
    const continuation = results.length > 0;
    if (continuation && (!entry || !entry.pending.size)) throw new CopilotAdapterError("Stale or wrong-thread tool results", 409);
    if (!continuation && entry?.pending.size) throw new CopilotAdapterError("Missing pending tool results", 409);
    if (continuation && newUser) throw new CopilotAdapterError("Complete pending tools before sending a new user turn", 409);
    if (entry?.poisoned) throw new CopilotAdapterError("Native session unavailable; start a new thread", 409);
    if (!continuation && (!user || typeof user.content !== "string" || !user.content.trim())) {
      throw new CopilotAdapterError("A nonempty text user message is required");
    }
    if (!continuation && user && entry?.turnIds.has(user.id)) throw new CopilotAdapterError("Duplicate user turn", 409);
    if (entry && entry.turnIds.size >= this.limits.turns) throw new CopilotAdapterError("Thread turn limit reached; start a new thread", 409);
    if (input.tools.length > this.limits.pending || new Set(input.tools.map((t) => t.name)).size !== input.tools.length) {
      throw new CopilotAdapterError("Duplicate or excessive frontend tool declarations");
    }
    for (const tool of input.tools) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(tool.name) ||
          !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
        throw new CopilotAdapterError("Invalid frontend tool declaration");
      }
    }
    const toolDefinitions = JSON.stringify(input.tools);
    if (entry && !continuation && entry.toolDefinitions !== toolDefinitions) {
      throw new CopilotAdapterError("Tool definitions changed; start a new thread", 409);
    }
    if (continuation) {
      const ids = results.map((r) => r.toolCallId);
      if (new Set(ids).size !== ids.length) throw new CopilotAdapterError("Duplicate tool results", 409);
      if (ids.some((id) => !entry!.pending.has(id))) {
        throw new CopilotAdapterError("Stale or wrong-thread tool results", 409);
      }
      if (entry!.answeredResults.size + entry!.pendingAnswers.size + results.length > this.limits.events) throw new CopilotAdapterError("Thread answered-tool limit reached", 409);
    }
    if (!entry) {
      // Expire only idle sessions; never evict another thread's active run.
      for (const [id, old] of this.entries) {
        if (!old.active && Date.now() - old.lastUsed > this.limits.idle) await this.dispose(id, old);
      }
      if (this.entries.size >= this.limits.threads) throw new CopilotAdapterError("Session capacity reached", 503);
      entry = {
        state: structuredClone(this.options.state?.initial), active: false, lastUsed: Date.now(),
        turnIds: new Set(), toolDefinitions, frontendNames: new Set(input.tools.map((t) => t.name)), backendNames: new Set(),
        pending: new Map(), pendingAnswers: new Map(), outstanding: new Set(), backendResults: new Map(), answeredResults: new Map(),
        answeredRequests: new Map(), requestCalls: new Map(),
        toolMetadata: new Map(), childStarts: new Map(),
        lifetime: new AbortController(), poisoned: false,
      };
      this.entries.set(input.threadId, entry);
    }
    const current = entry;
    try {
      if (this.options.state) current.state = this.options.state.accept(input.state, current.state);
    } catch (error) {
      if (!current.session) this.entries.delete(input.threadId);
      throw new CopilotAdapterError(error instanceof Error ? error.message : "Invalid state", 409);
    }
    // Native work starts only after validation and per-thread reservation.
    current.active = true;
    for (const result of results) current.pendingAnswers.set(result.toolCallId, {
      id: `result:${result.toolCallId}`, role: "tool", toolCallId: result.toolCallId, content: result.content,
      ...(result.error === undefined ? {} : { error: result.error }),
    });
    const completions = continuation && current.pendingAnswers.size === current.pending.size
      ? [...current.pendingAnswers.values()] : [];
    const mapper = new CopilotEventMapper({
      threadId: input.threadId, runId: input.runId, maxOutputBytes: this.limits.output, maxEvents: this.limits.events,
    });
    for (const [id, tool] of current.toolMetadata) {
      mapper.restorePendingTool(id, tool.toolName, tool.arguments, tool.agentId, tool.parentToolCallId);
    }
    for (const [id, pending] of current.pending) {
      mapper.restorePendingTool(id, pending.toolName, pending.arguments, pending.agentId, pending.parentToolCallId);
    }
    const queue = new EventQueue(this.limits.queueEvents, this.limits.queueBytes);
    const resolved = new Set(completions.map((r) => r.toolCallId));
    let terminal = false;
    let handoff = false;
    let naturallyFinished = false;
    let handoffTimer: ReturnType<typeof setImmediate> | undefined;
    let work: Promise<void> | undefined;
    const applicationActivities = new Map<string, Record<string, unknown>>();
    const preserveApplicationActivity = (event: BaseEvent): BaseEvent => {
      if (event.type !== EventType.ACTIVITY_SNAPSHOT || event.activityType !== "copilot-sdk:tool") return event;
      const id = String(event.messageId);
      const content = event.content as Record<string, unknown>;
      const application = applicationActivities.get(id);
      if (typeof content.source === "string") {
        if (!application && applicationActivities.size >= this.limits.events) throw new Error("Application activity limit exceeded");
        applicationActivities.set(id, content);
      } else if (application) {
        event = { ...event, content: {
          ...content, source: application.source, command: application.command,
          ...(content.output === "" && typeof application.output === "string" ? { output: application.output } : {}),
          truncated: Boolean(content.truncated || application.truncated),
          ...(application.exitCode === undefined ? {} : { exitCode: application.exitCode }),
        } };
        if (content.status !== "running") applicationActivities.delete(id);
      }
      return event;
    };
    const finish = (error?: string, cancelled = false, code?: string): void => {
      if (terminal) return;
      terminal = true;
      const events = mapper.finish(error, cancelled);
      if (!events.length && error !== undefined) events.push({
        type: EventType.RUN_ERROR, message: error, code: cancelled ? "CANCELLED" : "COPILOT_SDK_ERROR",
      });
      if (code) for (const event of events) if (event.type === EventType.RUN_ERROR) event.code = code;
      try { events.forEach((event) => queue.push(preserveApplicationActivity(event))); queue.end(); }
      catch { queue.fail(events); }
    };
    const emit = (event: BaseEvent): void => {
      if (terminal) return;
      queue.push(preserveApplicationActivity(event));
      if (event.type === EventType.RUN_ERROR || event.type === EventType.RUN_FINISHED) {
        naturallyFinished = event.type === EventType.RUN_FINISHED;
        terminal = true;
        queue.end();
      }
    };
    const cancel = (): void => {
      current.poisoned = true;
      current.lifetime.abort();
      finish("Run cancelled", true);
      void current.session?.abort().catch(() => {});
    };
    current.cancel = cancel;
    current.emit = emit;
    const readyForHandoff = (): boolean => {
      if (!current.pending.size) return false;
      const waiting = new Set(current.pending.keys());
      for (const pending of current.pending.values()) {
        let agentId = pending.agentId;
        const visited = new Set<string>();
        while (agentId && !visited.has(agentId)) {
          visited.add(agentId);
          const child = current.childStarts.get(agentId);
          if (!child) break;
          waiting.add(child.data.toolCallId);
          agentId = child.data.parentId;
        }
      }
      return [...current.outstanding].every((id) => waiting.has(id));
    };
    current.onEvent = (event) => {
      if (terminal) return;
      if (event.type === "tool.execution_complete" &&
          current.answeredResults.has(event.data.toolCallId) && !resolved.has(event.data.toolCallId)) return;
      try {
        if (event.type === "assistant.message") {
          const calls = (event.data.toolRequests ?? []).filter((tool) => current.frontendNames.has(tool.name));
          const ids = calls.map((tool) => tool.toolCallId);
          if (new Set(ids).size !== ids.length || ids.some((id) => !id.trim() ||
              (current.answeredResults.has(id) && !current.outstanding.has(id)))) {
            throw new CopilotAdapterError("Missing, duplicate, or reused native frontend toolCallId", 409, "FRONTEND_TOOL_IDENTITY_ERROR");
          }
          for (const tool of event.data.toolRequests ?? []) {
            if (current.toolMetadata.size >= this.limits.events && !current.toolMetadata.has(tool.toolCallId)) throw new Error("Outstanding tool limit exceeded");
            current.outstanding.add(tool.toolCallId);
            current.toolMetadata.set(tool.toolCallId, {
              toolName: tool.name, arguments: tool.arguments, agentId: event.agentId,
              parentToolCallId: event.agentId ? current.childStarts.get(event.agentId)?.data.toolCallId : undefined,
            });
          }
        }
        if (event.type === "tool.execution_start") {
          if (current.frontendNames.has(event.data.toolName) &&
              !event.data.toolCallId.trim()) {
            throw new CopilotAdapterError("Missing native frontend toolCallId", 409, "FRONTEND_TOOL_IDENTITY_ERROR");
          }
          if (current.answeredRequests.has(event.data.toolCallId)) return;
          current.outstanding.add(event.data.toolCallId);
          current.toolMetadata.set(event.data.toolCallId, {
            toolName: event.data.toolName, arguments: event.data.arguments, agentId: event.agentId,
            parentToolCallId: event.data.parentToolCallId ?? (event.agentId ? current.childStarts.get(event.agentId)?.data.toolCallId : undefined),
          });
        }
        if (event.type === "tool.execution_complete") {
          current.outstanding.delete(event.data.toolCallId);
          current.toolMetadata.delete(event.data.toolCallId);
        }
        if (event.type === "subagent.started") {
          const id = event.agentId ?? `subagent:${event.data.toolCallId}`;
          if (current.childStarts.size >= this.limits.pending && !current.childStarts.has(id)) throw new Error("Active subagent limit exceeded");
          current.childStarts.set(id, event);
        }
        if (event.type === "subagent.completed" || event.type === "subagent.failed") {
          for (const [id, started] of current.childStarts) {
            if (started.data.toolCallId === event.data.toolCallId) current.childStarts.delete(id);
          }
        }
        if (event.type === "external_tool.requested" && !current.backendNames.has(event.data.toolName)) {
          if (!current.frontendNames.has(event.data.toolName)) throw new Error("Undeclared external tool request");
          const requestId = event.data.requestId;
          if (typeof requestId !== "string" || !requestId.trim()) {
            throw new CopilotAdapterError("Missing native frontend requestId", 409, "FRONTEND_TOOL_IDENTITY_ERROR");
          }
          const owner = current.requestCalls.get(requestId);
          if (owner !== undefined && owner !== event.data.toolCallId) {
            throw new CopilotAdapterError("Native frontend requestId belongs to another tool call", 409, "FRONTEND_TOOL_IDENTITY_ERROR");
          }
          const answeredRequest = current.answeredRequests.get(event.data.toolCallId);
          if (answeredRequest !== undefined && answeredRequest === requestId) return;
          if (!event.data.toolCallId.trim() || answeredRequest !== undefined) {
            throw new CopilotAdapterError("Missing or reused native frontend toolCallId", 409, "FRONTEND_TOOL_IDENTITY_ERROR");
          }
          const previous = current.pending.get(event.data.toolCallId);
          if (previous && previous.requestId !== event.data.requestId) throw new Error("Conflicting pending request");
          if (!previous && current.pending.size >= this.limits.pending) throw new Error("Pending tool limit exceeded");
          if (owner === undefined && current.requestCalls.size >= this.limits.events) throw new Error("Thread pending-request limit exceeded");
          current.requestCalls.set(requestId, event.data.toolCallId);
          current.pending.set(event.data.toolCallId, {
            requestId: event.data.requestId, toolName: event.data.toolName, arguments: event.data.arguments,
            agentId: event.agentId ?? current.toolMetadata.get(event.data.toolCallId)?.agentId,
            parentToolCallId: current.toolMetadata.get(event.data.toolCallId)?.parentToolCallId ??
              (event.agentId ? current.childStarts.get(event.agentId)?.data.toolCallId : undefined),
          });
          current.outstanding.add(event.data.toolCallId);
        }
        for (const mapped of mapper.mapEvent(event)) {
          // Browser results already exist in AG-UI history. Native completion updates activity, not a second result.
          if (mapped.type === EventType.TOOL_CALL_RESULT && resolved.has(String(mapped.toolCallId))) continue;
          if (mapped.type === EventType.TOOL_CALL_RESULT) {
            if (current.backendResults.size >= this.limits.events) throw new Error("Thread tool-result limit exceeded");
            current.backendResults.set(String(mapped.toolCallId), digest(String(mapped.content)));
          }
          emit(mapped);
        }
        if (readyForHandoff()) {
          if (handoffTimer) clearImmediate(handoffTimer);
          handoffTimer = setImmediate(() => {
            if (!terminal && readyForHandoff()) {
              handoff = true;
              finish();
            }
          });
        }
      } catch (error) {
        current.poisoned = true;
        finish(error instanceof Error ? error.message : "SDK event mapping failed", false, error instanceof CopilotAdapterError ? error.code : undefined);
      }
    };
    const timer = setTimeout(() => {
      current.poisoned = true;
      finish("Run timed out", true);
      current.lifetime.abort();
      void current.session?.abort().catch(() => {});
    }, this.limits.timeout);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      mapper.start().forEach(emit);
      for (const started of current.childStarts.values()) mapper.mapEvent(started).forEach(emit);
      if (this.options.state) emit({ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(current.state) });
      work = (async () => {
        if (!current.session) {
          const backendTools = this.options.tools?.({
            getState: () => structuredClone(current.state),
            setState: (state, delta) => {
              if (current.lifetime.signal.aborted || !current.active) throw new Error("No active state turn");
              current.state = structuredClone(state);
              current.emit?.({ type: EventType.STATE_DELTA, delta });
            },
            emitActivity: (messageId, activityType, content) => {
              if (!current.active || current.lifetime.signal.aborted) return;
              current.emit?.({ type: EventType.ACTIVITY_SNAPSHOT, messageId, activityType, content, replace: true });
            },
            signal: current.lifetime.signal,
          }) ?? [];
          if (backendTools.some((tool) => current.frontendNames.has(tool.name))) throw new Error("Frontend tool shadows a server tool");
          current.backendNames = new Set(backendTools.map((tool) => tool.name));
          current.session = await this.options.client.createSession({
            model: this.options.model ?? "gpt-5.4-mini", streaming: true,
            includeSubAgentStreamingEvents: true,
            availableTools: [...backendTools.map((tool) => tool.name), ...current.frontendNames],
            ...this.options.sessionConfig,
            tools: [...backendTools, ...input.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))],
            // This listener is installed by the SDK before session.create can emit events.
            onEvent: (event) => current.onEvent?.(event),
          });
        }
        if (terminal || current.poisoned || this.closed) return;
        if (continuation) {
          if (!completions.length) {
            handoff = true;
            finish();
            return;
          }
          const requests = completions.map((result) => ({ result, pending: current.pending.get(result.toolCallId)! }));
          for (const { result, pending } of requests) {
            current.pending.delete(result.toolCallId);
            current.pendingAnswers.delete(result.toolCallId);
            current.answeredResults.set(result.toolCallId, answerDigest(result));
            current.answeredRequests.set(result.toolCallId, pending.requestId);
          }
          // Resolve the original RPC requests, never session.send or transcript replay.
          await Promise.all(requests.map(async ({ result, pending }) => {
            const response = await current.session!.rpc.tools.handlePendingToolCall({
              requestId: pending.requestId,
              result: result.error
                ? { textResultForLlm: result.content, resultType: "failure", error: result.error }
                : result.content,
            });
            if (!response.success) throw new Error("Native pending tool response was rejected");
          }));
        } else {
          current.turnIds.add(user!.id);
          const statePrompt = this.options.state?.prompt?.(current.state);
          await current.session.send({ prompt: `${statePrompt ? `${statePrompt}\n\n` : ""}${user!.content}` });
        }
      })().catch((error) => {
        current.poisoned = true;
        finish(error instanceof Error ? error.message : "Native SDK failed");
      });
      while (true) {
        const event = await queue.next();
        if (!event) break;
        yield event;
      }
    } finally {
      clearTimeout(timer);
      if (handoffTimer) clearImmediate(handoffTimer);
      options.signal?.removeEventListener("abort", cancel);
      current.cancel = undefined;
      current.onEvent = undefined;
      current.emit = undefined;
      current.lastUsed = Date.now();
      // Consumer return/disconnect is cancellation, unlike a deliberate browser handoff.
      if ((!handoff && !naturallyFinished) || current.poisoned || this.closed) {
        current.poisoned = true;
        current.lifetime.abort();
        const sessionBeforeDisposal = current.session;
        try { await this.dispose(input.threadId, current); } catch { /* Entry is already invalidated. */ }
        await work;
        // A slow session.create may have completed after the first disposal.
        if (current.session && current.session !== sessionBeforeDisposal) await current.session.disconnect().catch(() => {});
      } else {
        await work;
      }
      current.active = false;
    }
    } finally {
      this.activeThreads.delete(input.threadId);
    }
  }
}

/** In-process AG-UI client integration; HTTP hosts can consume adapter.stream directly. */
export class CopilotAgent extends AbstractAgent {
  constructor(readonly adapter: CopilotAdapter, config: AgentConfig = {}) { super(config); }
  override clone(): CopilotAgent { return Object.assign(super.clone(), { adapter: this.adapter }); }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of this.adapter.stream(input, { signal: controller.signal })) subscriber.next(event);
          subscriber.complete();
        } catch (error) { subscriber.error(error); }
      })();
      return () => controller.abort();
    });
  }
}
