import { AGUIError, Message, ResumeEntry, RunAgentInput, State } from "@ag-ui/core";

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
  /**
   * Most container entries (array elements, object and record keys) the
   * enforcement stage will walk for one event or one outgoing input before
   * failing the run with an AGUIEnforcementLimitError. Defaults to
   * DEFAULT_MAX_ENFORCED_ENTRIES (1,000,000); `Infinity` disables the limit.
   */
  maxEnforcedEntries?: number;
}

export type HttpAgentFetchFn = (url: string, requestInit: RequestInit) => Promise<Response>;

export interface HttpAgentConfig extends AgentConfig {
  url: string;
  headers?: Record<string, string>;
  fetch?: HttpAgentFetchFn;
  /**
   * Abort the run if response headers do not arrive within this many
   * milliseconds, or if no bytes arrive on the response body for this long.
   * Any body chunk — including SSE comment keepalives (`: ping`) — resets the
   * timer. Unset (the default) waits indefinitely. Must be a positive finite
   * number when provided.
   */
  idleTimeoutMs?: number;
}

/** Accept a positive finite timeout, or undefined for no timeout. */
export function resolveIdleTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new AGUIError(`Invalid idleTimeoutMs ${String(value)}: expected a positive finite number.`);
}

export interface RunAgentParameters
  extends Partial<Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">> {
  /** Per-interrupt responses addressing every open interrupt from the previous run. */
  resume?: ResumeEntry[];
}
