import { Message, ResumeEntry, RunAgentInput, State, ToolMessage } from "@ag-ui/core";

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
  /**
   * Explicit host opt-in for a server that durably collects frontend results
   * while interrupts remain. Disabled by default; enable before run/connect
   * so the client can record the authoritative interrupted history.
   * This does not authorize tools or answer approvals on the server.
   */
  allowToolResultContinuation?: boolean;
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
}

export interface RunAgentParameters
  extends Partial<Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">> {
  /** Per-interrupt responses addressing every open interrupt from the previous run. */
  resume?: ResumeEntry[];
  /**
   * Exact new frontend results to persist without answering pending interrupts.
   * Requires allowToolResultContinuation and a prior interrupted run/replay.
   * Add these results to agent.messages first. Other history/state must remain
   * unchanged; native interrupt calls, expired interrupts, resumes, unknown and
   * already answered calls are rejected. Only these results enter input.messages;
   * this local option adds no protocol field and fabricates no resume entries.
   */
  toolResultContinuation?: ToolMessage[];
}
