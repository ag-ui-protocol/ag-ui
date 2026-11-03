import {
  AbstractAgent,
  type RunAgentInput,
  type BaseEvent,
  type Message,
  type State,
  EventType,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextMessageStartEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type ToolCallStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type StateSnapshotEvent,
  type RawEvent,
  PROTOCOL_VERSION,
  contentToText,
} from "@ag-ui/client";
import { Observable, type Subscriber } from "rxjs";

const IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_SIZE = 1024 * 1024; // 1MB
const DEFAULT_MAX_THREADS = 5_000;

/** The error watsonx orchestrate reports for a `thread_id` it does not know. */
const THREAD_MISSING = /thread id.*does not exist/i;

/** Request body keys the adapter sets itself; `forwardedProps` cannot override them. */
const RESERVED_BODY_KEYS = new Set([
  "message",
  "agent_id",
  "environment_id",
  "thread_id",
]);

/** A tool response reported by watsonx orchestrate during a run. */
export interface WatsonxToolResult {
  toolCallId: string;
  /** Tool name exactly as watsonx reports it (workspace prefix included). */
  name: string;
  args: unknown;
  /** The raw tool response, serialized to a string when it is not one already. */
  content: string;
}

/**
 * Called for every tool response. Return a new state to publish it as a
 * `STATE_SNAPSHOT`; return `undefined` to leave the state unchanged. `state`
 * is the current state of the run, starting from `input.state`.
 */
export type WatsonxToolResultHandler = (
  result: WatsonxToolResult,
  context: { state: State; input: RunAgentInput },
) => State | undefined;

/**
 * Where the adapter keeps the watsonx thread of each AG-UI thread. The
 * default keeps them in memory, so a restart starts new watsonx threads; pass
 * a shared store to keep conversations across restarts or instances.
 */
export interface WatsonxThreadStore {
  get(key: string): string | undefined | Promise<string | undefined>;
  set(key: string, watsonxThreadId: string): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export interface WatsonxRunsAgentConfig {
  region: string;
  instanceId: string;
  agentId: string;
  /** Agent environment (draft or live). Optional for the API. */
  environmentId?: string;
  apiKey?: string;
  bearerToken?: string;
  /**
   * Instance URL to send runs to, in place of the one derived from `region`
   * and `instanceId`. Use it for a private endpoint or a mock.
   */
  baseUrl?: string;
  /** Maximum duration of a run, in milliseconds. Defaults to 120 000. */
  timeoutMs?: number;
  onToolResult?: WatsonxToolResultHandler;
  threadStore?: WatsonxThreadStore;
}

/** In-memory thread store that evicts the least recently written thread. */
export class InMemoryWatsonxThreadStore implements WatsonxThreadStore {
  private threads = new Map<string, string>();

  constructor(private maxThreads = DEFAULT_MAX_THREADS) {}

  get(key: string): string | undefined {
    return this.threads.get(key);
  }

  set(key: string, watsonxThreadId: string): void {
    this.threads.delete(key);
    this.threads.set(key, watsonxThreadId);
    if (this.threads.size > this.maxThreads) {
      const oldest = this.threads.keys().next().value;
      if (oldest !== undefined) this.threads.delete(oldest);
    }
  }

  delete(key: string): void {
    this.threads.delete(key);
  }
}

interface WatsonxRunEvent {
  event: string;
  data?: Record<string, unknown>;
}

interface WatsonxContentPart {
  response_type?: string;
  text?: string;
}

interface WatsonxStepDetail {
  type?: string;
  /** `tool_calls`: the calls announced by the agent. */
  tool_calls?: { id?: string; name?: string; args?: unknown }[];
  /** `tool_call` / `tool_response`: one call, repeated with its response. */
  tool_call_id?: string;
  name?: string;
  args?: unknown;
  content?: unknown;
}

/** IAM token shared by an agent and its clones. */
interface TokenCache {
  token?: string;
  expiresAt: number;
  pending?: Promise<string>;
}

/**
 * Parses one line of the runs stream. watsonx sends NDJSON
 * (`{"id","event","data"}` per line), except for errors, which arrive
 * prefixed with `data: ` like SSE; both forms are accepted.
 */
function parseLine(line: string): WatsonxRunEvent | null {
  let payload = line.trim();
  if (
    !payload ||
    payload.startsWith(":") ||
    /^(event|id|retry):/.test(payload)
  ) {
    return null;
  }
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload) as Partial<WatsonxRunEvent> | null;
    return typeof parsed?.event === "string"
      ? (parsed as WatsonxRunEvent)
      : null;
  } catch {
    return null;
  }
}

function lineTooLong(): Error {
  return new Error("watsonx stream buffer exceeded 1MB — aborting");
}

async function* readEvents(
  body: NonNullable<Response["body"]>,
): AsyncGenerator<WatsonxRunEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > MAX_BUFFER_SIZE) throw lineTooLong();
        const event = parseLine(line);
        if (event) yield event;
      }
      // Only the unfinished line counts: one read may carry many full lines.
      if (buffer.length > MAX_BUFFER_SIZE) throw lineTooLong();
    }
    const last = parseLine(buffer);
    if (last) yield last;
  } catch (err) {
    // Release the connection instead of leaving the body unread.
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

/** The text of the last user message: watsonx keeps the history in its thread. */
function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return contentToText(message.content).trim();
  }
  return "";
}

/**
 * Translates the events of one watsonx run into AG-UI events. It keeps the
 * invariants `@ag-ui/client` checks: a text message is closed before a tool
 * call opens, every tool call gets a result (otherwise a client would take it
 * for a frontend tool to execute), and the run ends with exactly one
 * RUN_FINISHED or RUN_ERROR.
 */
class RunTranslator {
  /** The last error watsonx reported for this run. */
  failure?: string;
  /** The watsonx thread the run belongs to, from `run.started`. */
  watsonxThreadId?: string;
  /** Whether an event other than RAW was emitted; a run is not retried after that. */
  emitted = false;
  /** Whether watsonx reported the end of the run (`run.completed` / `done`). */
  completed = false;

  private state: State;
  private textMessageId: string | null = null;
  private streamedText = false;
  private toolCalls = new Map<string, { args: unknown; answered: boolean }>();
  /**
   * Responses to calls not announced yet. watsonx can send a response before
   * the call record that carries its arguments (collaborator agents do), so
   * the response waits for that record, and is released on its own when the
   * run moves past the tool steps.
   */
  private pendingResponses = new Map<
    string,
    { name: string; content: string }
  >();

  constructor(
    private subscriber: Subscriber<BaseEvent>,
    private input: RunAgentInput,
    private onToolResult?: WatsonxToolResultHandler,
  ) {
    this.state = input.state;
  }

  handle(event: WatsonxRunEvent): void {
    const rawEvent: RawEvent = {
      type: EventType.RAW,
      event,
      source: "watsonx",
    };
    this.subscriber.next(rawEvent);

    if (
      [
        "run.completed",
        "done",
        "run.failed",
        "run.cancelled",
        "run.expired",
        "error",
      ].includes(event.event)
    ) {
      this.flushPendingResponses();
    }

    const data = event.data ?? {};
    switch (event.event) {
      case "run.started":
        if (typeof data.thread_id === "string") {
          this.watsonxThreadId = data.thread_id;
        }
        return;

      case "message.delta": {
        const delta = data.delta as
          | { content?: WatsonxContentPart[] }
          | undefined;
        for (const part of delta?.content ?? []) {
          if (part?.response_type === "text" && part.text) this.text(part.text);
        }
        return;
      }

      case "message.created": {
        // The full message: only used when nothing was streamed as deltas.
        if (this.streamedText) return;
        const message = data.message as
          | { content?: WatsonxContentPart[] }
          | undefined;
        const full = (message?.content ?? [])
          .filter((part) => part?.response_type === "text" && part.text)
          .map((part) => part.text)
          .join("\n");
        if (full) this.text(full);
        return;
      }

      case "run.step.delta": {
        const delta = data.delta as
          | { step_details?: WatsonxStepDetail[] }
          | undefined;
        for (const step of delta?.step_details ?? []) this.step(step);
        return;
      }

      case "run.completed":
      case "done":
        this.completed = true;
        return;

      case "run.failed":
      case "run.cancelled":
      case "run.expired":
      case "error":
        this.failure =
          asString(data.last_error) ||
          asString(data.message) ||
          asString(data.error) ||
          event.event;
        return;

      default:
        // run.step.intermediate ("Thinking…"), message.started,
        // message.completed: only surfaced as RAW.
        return;
    }
  }

  /** Closes what is still open and ends the run. */
  finish(): void {
    // A stream cut before the end of the run is not a finished run.
    if (!this.failure && !this.completed) {
      this.failure = "stream ended before the run completed";
    }
    this.flushPendingResponses();
    this.closeText();
    for (const [toolCallId, call] of this.toolCalls) {
      if (!call.answered) this.result(toolCallId, "");
    }
    if (this.failure) {
      const runError: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: `watsonx run failed: ${this.failure.slice(0, 200)}`,
        code: "WATSONX_RUN_FAILED",
      };
      this.send(runError);
      return;
    }
    const runFinished: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: this.input.threadId,
      runId: this.input.runId,
    };
    this.send(runFinished);
  }

  private text(delta: string): void {
    this.flushPendingResponses();
    if (!this.textMessageId) {
      this.textMessageId = crypto.randomUUID();
      const msgStart: TextMessageStartEvent = {
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.textMessageId,
        role: "assistant",
      };
      this.send(msgStart);
    }
    this.streamedText = true;
    const msgContent: TextMessageContentEvent = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.textMessageId,
      delta,
    };
    this.send(msgContent);
  }

  private closeText(): void {
    if (!this.textMessageId) return;
    const msgEnd: TextMessageEndEvent = {
      type: EventType.TEXT_MESSAGE_END,
      messageId: this.textMessageId,
    };
    this.send(msgEnd);
    this.textMessageId = null;
  }

  private step(step: WatsonxStepDetail): void {
    switch (step.type) {
      case "tool_calls":
        for (const call of step.tool_calls ?? []) {
          if (call.id && call.name)
            this.callRecord(call.id, call.name, call.args);
        }
        return;
      case "tool_call":
        if (step.tool_call_id && step.name) {
          this.callRecord(step.tool_call_id, step.name, step.args);
        }
        return;
      case "tool_response": {
        if (!step.tool_call_id || !step.name) return;
        const content = asString(step.content);
        if (step.args !== undefined) {
          this.callRecord(step.tool_call_id, step.name, step.args);
        }
        if (this.toolCalls.has(step.tool_call_id)) {
          this.answer(step.tool_call_id, step.name, content);
        } else if (!this.pendingResponses.has(step.tool_call_id)) {
          this.pendingResponses.set(step.tool_call_id, {
            name: step.name,
            content,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Announces a call, then answers it if its response came first. */
  private callRecord(toolCallId: string, name: string, args: unknown): void {
    this.toolCall(toolCallId, name, args);
    const pending = this.pendingResponses.get(toolCallId);
    if (!pending) return;
    this.pendingResponses.delete(toolCallId);
    this.answer(toolCallId, pending.name, pending.content);
  }

  /** Answers the responses whose call never came, without arguments. */
  private flushPendingResponses(): void {
    for (const [toolCallId, { name, content }] of this.pendingResponses) {
      this.toolCall(toolCallId, name, undefined);
      this.answer(toolCallId, name, content);
    }
    this.pendingResponses.clear();
  }

  /** Emits a call's result once, then lets `onToolResult` update the state. */
  private answer(toolCallId: string, name: string, content: string): void {
    const args = this.toolCalls.get(toolCallId)?.args;
    if (!this.result(toolCallId, content)) return;
    const state = this.onToolResult?.(
      { toolCallId, name, args, content },
      { state: this.state, input: this.input },
    );
    if (state !== undefined) {
      this.state = state;
      const stateSnapshot: StateSnapshotEvent = {
        type: EventType.STATE_SNAPSHOT,
        snapshot: state,
      };
      this.send(stateSnapshot);
    }
  }

  /** Announces a tool call once: watsonx repeats the call with its response. */
  private toolCall(toolCallId: string, name: string, args: unknown): void {
    if (this.toolCalls.has(toolCallId)) return;
    this.toolCalls.set(toolCallId, { args, answered: false });

    this.closeText();
    const toolStart: ToolCallStartEvent = {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: name,
    };
    this.send(toolStart);
    const toolArgs: ToolCallArgsEvent = {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(args ?? {}),
    };
    this.send(toolArgs);
    const toolEnd: ToolCallEndEvent = {
      type: EventType.TOOL_CALL_END,
      toolCallId,
    };
    this.send(toolEnd);
  }

  /** Emits the result of a tool call once. Returns whether it was emitted. */
  private result(toolCallId: string, content: string): boolean {
    const call = this.toolCalls.get(toolCallId);
    if (!call || call.answered) return false;
    call.answered = true;
    const toolResult: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: crypto.randomUUID(),
      toolCallId,
      content,
      role: "tool",
    };
    this.send(toolResult);
    return true;
  }

  private send(event: BaseEvent): void {
    this.emitted = true;
    this.subscriber.next(event);
  }
}

/**
 * AG-UI agent for the watsonx orchestrate runs API
 * (`/v1/orchestrate/runs/stream`). Unlike `WatsonxAgent`, which calls the
 * OpenAI-compatible chat completions endpoint and only receives the agent's
 * text, the runs API also streams each step of the run, including the raw
 * responses of the agent's tools. They are surfaced as TOOL_CALL_* events,
 * and `onToolResult` can turn them into state.
 *
 * Tools run on watsonx: frontend tools (`input.tools`) are not forwarded.
 */
export class WatsonxRunsAgent extends AbstractAgent {
  private config: WatsonxRunsAgentConfig;
  private baseUrlOverride?: string;
  private tokenCache: TokenCache = { expiresAt: 0 };
  private threadStore: WatsonxThreadStore;
  private activeAbortController?: AbortController;

  constructor(config: WatsonxRunsAgentConfig) {
    super({ agentId: config.agentId });
    if (!config.apiKey && !config.bearerToken) {
      throw new Error("WatsonxRunsAgent requires either apiKey or bearerToken");
    }
    this.config = config;
    this.baseUrlOverride = config.baseUrl?.replace(/\/+$/, "");
    this.threadStore = config.threadStore ?? new InMemoryWatsonxThreadStore();
    if (config.bearerToken) {
      this.tokenCache.token = config.bearerToken;
      this.tokenCache.expiresAt = Date.now() + 55 * 60 * 1000;
    }
  }

  private get baseUrl(): string {
    if (this.baseUrlOverride) return this.baseUrlOverride;
    const { region, instanceId } = this.config;
    return `https://api.${region}.watson-orchestrate.cloud.ibm.com/instances/${instanceId}`;
  }

  private async getToken(): Promise<string> {
    const cache = this.tokenCache;
    if (cache.token && Date.now() < cache.expiresAt) return cache.token;

    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error(
        "watsonx: bearer token expired and no apiKey provided for refresh",
      );
    }

    cache.pending ??= this.refreshToken(apiKey).finally(() => {
      cache.pending = undefined;
    });
    return cache.pending;
  }

  private async refreshToken(apiKey: string): Promise<string> {
    const response = await fetch(IAM_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${encodeURIComponent(apiKey)}`,
    });

    if (!response.ok) {
      throw new Error(
        `watsonx IAM token exchange failed: HTTP ${response.status}`,
      );
    }

    const data = await response.json();
    if (!data.access_token || typeof data.access_token !== "string") {
      throw new Error("watsonx IAM response missing access_token");
    }
    if (!data.expiration || typeof data.expiration !== "number") {
      throw new Error("watsonx IAM response missing expiration");
    }
    this.tokenCache.token = data.access_token;
    // A minute of margin: a token expiring mid-run breaks the stream.
    this.tokenCache.expiresAt = data.expiration * 1000 - 60_000;
    return data.access_token;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abortController = new AbortController();
      this.activeAbortController = abortController;
      this.stream(input, subscriber, abortController.signal)
        .catch((err) => {
          if (abortController.signal.aborted) return;
          const message =
            err instanceof Error
              ? `watsonx request failed: ${err.message.slice(0, 200)}`
              : "watsonx request failed";
          const errorEvent: RunErrorEvent = {
            type: EventType.RUN_ERROR,
            message,
            code: "WATSONX_ERROR",
          };
          subscriber.next(errorEvent);
        })
        .finally(() => {
          subscriber.complete();
          if (this.activeAbortController === abortController) {
            this.activeAbortController = undefined;
          }
        });

      return () => abortController.abort();
    });
  }

  private async stream(
    input: RunAgentInput,
    subscriber: Subscriber<BaseEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    const runStarted: RunStartedEvent = {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      protocolVersion: PROTOCOL_VERSION,
    };
    subscriber.next(runStarted);

    const question = lastUserText(input.messages);
    if (!question) throw new Error("no user message to send");

    // watsonx thread ids belong to one instance and environment, so a store
    // shared across configurations must not mix them up.
    const threadKey = JSON.stringify([
      this.baseUrl,
      this.config.environmentId ?? null,
      this.config.agentId,
      input.threadId,
    ]);
    let watsonxThreadId = await this.threadStore.get(threadKey);

    for (let attempt = 0; ; attempt++) {
      const translator = new RunTranslator(
        subscriber,
        input,
        this.config.onToolResult,
      );
      await this.consume(input, question, watsonxThreadId, translator, signal);

      // watsonx no longer knows the thread (expired or purged): start a new
      // one, once, and only if nothing was shown to the user yet.
      if (
        attempt === 0 &&
        watsonxThreadId &&
        !translator.emitted &&
        translator.failure &&
        THREAD_MISSING.test(translator.failure)
      ) {
        await this.threadStore.delete(threadKey);
        watsonxThreadId = undefined;
        continue;
      }

      // watsonx creates the thread on the first turn; later turns reuse it.
      if (
        translator.watsonxThreadId &&
        translator.watsonxThreadId !== watsonxThreadId
      ) {
        await this.threadStore.set(threadKey, translator.watsonxThreadId);
      }
      translator.finish();
      return;
    }
  }

  private async consume(
    input: RunAgentInput,
    question: string,
    watsonxThreadId: string | undefined,
    translator: RunTranslator,
    signal: AbortSignal,
  ): Promise<void> {
    const {
      agentId,
      environmentId,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = this.config;

    // forwardedProps go to watsonx as is (e.g. `context`), except for the
    // keys the adapter owns.
    const body: Record<string, unknown> = Object.fromEntries(
      Object.entries(
        (input.forwardedProps ?? {}) as Record<string, unknown>,
      ).filter(([key]) => !RESERVED_BODY_KEYS.has(key)),
    );
    body.message = { role: "user", content: question };
    body.agent_id = agentId;
    if (environmentId) body.environment_id = environmentId;
    if (watsonxThreadId) body.thread_id = watsonxThreadId;

    const token = await this.getToken();
    const response = await fetch(
      `${this.baseUrl}/v1/orchestrate/runs/stream?stream_timeout=${timeoutMs}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`watsonx returned HTTP ${response.status}`);
    }

    for await (const event of readEvents(response.body)) {
      translator.handle(event);
    }
  }

  override abortRun(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = undefined;
  }

  clone(): WatsonxRunsAgent {
    // Use AbstractAgent.clone() to copy base state (messages, state,
    // description, subscribers, middlewares, pendingInterrupts, etc.)
    const cloned = super.clone() as WatsonxRunsAgent;
    // Clones share the config, the IAM token and the thread store: the
    // CopilotKit runtime clones the agent for every request.
    cloned.config = this.config;
    cloned.baseUrlOverride = this.baseUrlOverride;
    cloned.tokenCache = this.tokenCache;
    cloned.threadStore = this.threadStore;
    cloned.activeAbortController = undefined;
    return cloned;
  }
}
