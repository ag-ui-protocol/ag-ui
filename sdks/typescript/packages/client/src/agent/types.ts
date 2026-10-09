import type {
  AgentCapabilities,
  BaseEvent,
  Interrupt,
  Message,
  ResumeEntry,
  RunAgentInput,
  State,
} from "@ag-ui/core";
import type { Observable } from "rxjs";
import type { DebugLogger } from "@/debug-logger";
import type { Middleware, MiddlewareNext } from "@/middleware/middleware";
import type { RunAgentResult } from "./agent";
import type { AgentSubscriber } from "./subscriber";

/** Normalized debug configuration for the AG-UI agent. */
export interface ResolvedAgentDebugConfig {
  enabled: boolean;
  events: boolean;
  lifecycle: boolean;
  verbose: boolean;
}

/** Debug input — boolean shorthand or granular config. */
export type AgentDebugConfig =
  | boolean
  | {
      events?: boolean;
      lifecycle?: boolean;
      verbose?: boolean;
    };

/** Resolves an AgentDebugConfig into a normalized ResolvedAgentDebugConfig. */
export function resolveAgentDebugConfig(
  debug: AgentDebugConfig | undefined,
): ResolvedAgentDebugConfig {
  if (!debug) return { enabled: false, events: false, lifecycle: false, verbose: false };
  if (debug === true) return { enabled: true, events: true, lifecycle: true, verbose: true };

  const events = debug.events ?? true;
  const lifecycle = debug.lifecycle ?? true;
  const verbose = debug.verbose ?? false;
  return { enabled: events || lifecycle, events, lifecycle, verbose };
}

export interface AgentConfig {
  agentId?: string;
  description?: string;
  threadId?: string;
  initialMessages?: Message[];
  initialState?: State;
  debug?: AgentDebugConfig;
}

export type HttpAgentFetchFn = (url: string, requestInit: RequestInit) => Promise<Response>;

export interface HttpAgentConfig extends AgentConfig {
  url: string;
  headers?: Record<string, string>;
  fetch?: HttpAgentFetchFn;
}

export interface RunAgentParameters
  extends Partial<Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">> {
  /** Per-interrupt responses addressing every open interrupt from the previous run. */
  resume?: ResumeEntry[];
}

/** Options for `connectAgent`. */
export interface ConnectAgentOptions {
  /**
   * When `false`, the connect stream skips event verification. The
   * compatibility boundary and event enforcement still run. Default: `true`.
   */
  verifyEvents?: boolean;
}

/**
 * The public surface of an agent, as a structural type.
 *
 * `AbstractAgent` has private members, so TypeScript compares it by identity:
 * an agent built from another copy or another version of `@ag-ui/client` does
 * not fit the `AbstractAgent` type, even when it has the same shape. Such an
 * agent does fit `Agent`. Use `Agent` at type boundaries that accept agents
 * from users, and keep `AbstractAgent` for subclasses.
 *
 * Members that `@ag-ui/client` 1.0.0 does not have are optional, so agents
 * from 1.0.x also fit this type.
 *
 * @example
 * ```ts
 * import type { Agent } from "@ag-ui/client";
 *
 * function registerAgent(agent: Agent) {
 *   agent.subscribe({ onRunFinalized: ({ agent }) => console.log(agent.threadId) });
 * }
 * ```
 */
export interface Agent {
  agentId?: string;
  description: string;
  threadId: string;
  messages: Message[];
  state: State;
  subscribers: AgentSubscriber<Agent>[];
  isRunning: boolean;
  pendingInterrupts: Interrupt[];
  /** The highest AG-UI protocol version this agent supports. */
  readonly maxProtocolVersion: string;
  readonly debug: ResolvedAgentDebugConfig;
  /**
   * The debug logger, or `undefined` when debug logging is off.
   *
   * Typed by its public members, not as the `DebugLogger` class: the class has
   * a private member, so it only matches itself, and a logger from another
   * copy of `@ag-ui/client` would not fit.
   */
  readonly debugLogger: Pick<DebugLogger, keyof DebugLogger> | undefined;
  run(input: RunAgentInput): Observable<BaseEvent>;
  getCapabilities?(): Promise<AgentCapabilities>;
  subscribe(subscriber: AgentSubscriber<Agent>): { unsubscribe(): void };
  /**
   * Adds middlewares that wrap every run.
   *
   * The parameter is structural, not `Middleware | MiddlewareFunction`: the
   * `Middleware` class has protected members and `MiddlewareFunction` names
   * `AbstractAgent`, so both only match their own copy of `@ag-ui/client`.
   * The function form is written as a method type so TypeScript checks its
   * `next` parameter in both directions, which lets a function that takes
   * `next: AbstractAgent` fit.
   */
  use(
    ...middlewares: (
      | Pick<Middleware, "run">
      | { fn(input: RunAgentInput, next: MiddlewareNext): Observable<BaseEvent> }["fn"]
    )[]
  ): this;
  runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber<Agent>,
  ): Promise<RunAgentResult>;
  connectAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber<Agent>,
    options?: ConnectAgentOptions,
  ): Promise<RunAgentResult>;
  abortRun(): void;
  detachActiveRun(): Promise<void>;
  clone(): Agent;
  addMessage(message: Message): void;
  addMessages(messages: Message[]): void;
  setMessages(messages: Message[]): void;
  setState(state: State): void;
  /**
   * Whether the agent can reconnect to a run with `connectAgent`. Optional
   * because agents from `@ag-ui/client` 1.0.x do not have it.
   */
  supportsConnect?(): boolean;
  /**
   * Settles when the active run ends. `undefined` when no run is active.
   * Optional because agents from `@ag-ui/client` 1.0.x do not have it.
   */
  readonly activeRunCompletion?: Promise<void>;
}
