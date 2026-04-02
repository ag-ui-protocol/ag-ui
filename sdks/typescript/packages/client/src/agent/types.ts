import { Message, RunAgentInput, State } from "@ag-ui/core";

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
 * Configuration for throttling subscriber notifications during streaming.
 *
 * Mutations are always applied immediately (`agent.messages`/`agent.state`
 * stay current); only subscriber notifications (`onMessagesChanged`,
 * `onStateChanged`) are coalesced.
 *
 * The first event always fires immediately (leading edge). Subsequent
 * notifications fire when either threshold is met. A trailing timer
 * ensures pending notifications are flushed. On stream completion,
 * any remaining pending notification is always delivered.
 */
export interface NotificationThrottleConfig {
  /**
   * Time-based throttle window in milliseconds.
   * Notifications are suppressed for this duration after each delivery;
   * only the latest state is delivered when the window expires.
   * Must be a non-negative finite number. Example: `16` ≈ 60 fps.
   */
  intervalMs: number;
  /**
   * Minimum new characters to accumulate before firing a notification.
   * When set, a notification also fires when this many new characters
   * have been appended to the active assistant message, even if the
   * time window has not yet elapsed.
   * Must be a non-negative finite number. Default: `0` (no minimum).
   */
  minChunkSize?: number;
}

export interface AgentConfig {
  agentId?: string;
  description?: string;
  threadId?: string;
  initialMessages?: Message[];
  initialState?: State;
  debug?: AgentDebugConfig;
  /**
   * Throttle subscriber notifications during streaming.
   * When omitted, every mutation fires a notification immediately.
   */
  notificationThrottle?: NotificationThrottleConfig;
}

export interface HttpAgentConfig extends AgentConfig {
  url: string;
  headers?: Record<string, string>;
}

export type RunAgentParameters = Partial<
  Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">
>;
