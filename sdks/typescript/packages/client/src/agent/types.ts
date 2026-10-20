import { Message, ResumeEntry, RunAgentInput, State } from "@ag-ui/core";

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

/**
 * How much conversation history the client uploads with each run.
 *
 * - `"full"` (default): every run carries the whole history, as before.
 * - `"server"`: the server owns the history. Each run carries only the messages
 *   the server has not confirmed yet, plus a cursor naming the last confirmed
 *   message in `forwardedProps["ag-ui:historyCursor"]`.
 * - `"auto"`: asks `getCapabilities()` once and uses `"server"` when the agent
 *   advertises `state.serverManagedHistory` (or `custom.serverManagedHistory`),
 *   `"full"` otherwise or when the lookup fails. Needs an agent that implements
 *   `getCapabilities()` (framework integrations do; the bare `HttpAgent` has no
 *   discovery endpoint, so use `"server"` with it, or assign `getCapabilities`).
 *
 * In server mode a message is confirmed once a run whose input carried it, or
 * whose events produced it, finishes with RUN_FINISHED, or once it arrives in a
 * MESSAGES_SNAPSHOT. Unconfirmed messages are sent after the cursor in list
 * order. `setMessages()` and a threadId change forget all confirmations, so
 * the next run sends the full history; a RUN_ERROR with code
 * `HISTORY_UNAVAILABLE` does the same through one transparent retry.
 */
export type HistoryMode = "full" | "server" | "auto";

/** Reduces the messages sent to the agent. Must not mutate its argument. */
export type MessageFilter = (messages: Message[]) => Message[];

export interface AgentConfig {
  agentId?: string;
  description?: string;
  threadId?: string;
  initialMessages?: Message[];
  initialState?: State;
  debug?: AgentDebugConfig;
  /**
   * Selects which messages are sent in `RunAgentInput.messages`. Runs on a
   * copy after activity messages are removed (and, in server history mode,
   * after confirmed messages are removed), so it only shapes the outgoing
   * input: `agent.messages` is never changed by it.
   */
  messageFilter?: MessageFilter;
  /** See {@link HistoryMode}. Defaults to `"full"`. */
  historyMode?: HistoryMode;
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
