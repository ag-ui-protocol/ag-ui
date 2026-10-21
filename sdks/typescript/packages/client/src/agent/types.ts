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
 * In server mode a message is confirmed once a run whose transport sent it,
 * or whose events produced it, finishes with RUN_FINISHED, or once it arrives
 * in a MESSAGES_SNAPSHOT. The delta is applied at the transport, after the
 * middleware chain, so middlewares see the full history. Unconfirmed messages
 * are sent after the cursor in list order, together with the owning assistant
 * message of every tool result sent and all system and developer messages
 * (which are never confirmed, and which a server-mode MESSAGES_SNAPSHOT does
 * not remove locally).
 *
 * When a confirmed message was removed or changed on the client (an edit, a
 * rewind, a regenerate, through `setMessages()`, an `agent.messages`
 * assignment or a subscriber mutation), that run sends the full history
 * without a cursor and the server decides how to reconcile it. So does a new
 * message `setMessages()` inserts before a confirmed one; a pure append keeps
 * the delta. A MESSAGES_SNAPSHOT is authoritative: confirmations are rebased
 * on it without counting as divergence. A threadId change forgets all confirmations, and a RUN_ERROR
 * with code `HISTORY_UNAVAILABLE` is answered by one transparent retry with
 * the full history and no cursor.
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
   * Selects which messages are sent in `RunAgentInput.messages`. Runs at the
   * transport, on every upload (middleware continuation runs included), after
   * activity messages are removed and, in server history mode, after
   * confirmed messages are removed. It only shapes the outgoing upload:
   * middlewares and `agent.messages` see the unfiltered history. Its output is
   * sent as is, except that in a server history delta a tool result it keeps
   * also keeps its owning assistant message, put back before the result if
   * the filter dropped it.
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
