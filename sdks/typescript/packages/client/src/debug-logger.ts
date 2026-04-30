import { ResolvedAgentDebugConfig, resolveAgentDebugConfig } from "@/agent/types";

/** Accepted input wherever a debug logger can be provided. */
export type DebugLoggerInput = DebugLogger | boolean | null | undefined;

/**
 * Resolves a DebugLoggerInput into a DebugLogger or undefined.
 * - `true` → creates a new DebugLogger with all logging enabled
 * - `DebugLogger` instance → returned as-is
 * - `false`, `null`, `undefined` → returns undefined
 */
export function resolveDebugLogger(input: DebugLoggerInput): DebugLogger | undefined {
  if (input instanceof DebugLogger) return input;
  if (input === true) return new DebugLogger(resolveAgentDebugConfig(true));
  return undefined;
}

/**
 * Centralized debug logger for the AG-UI event pipeline.
 * Handles verbose vs summary output based on config.
 */
export class DebugLogger {
  constructor(private config: ResolvedAgentDebugConfig) {}

  /**
   * Log an event-level debug message.
   * Only logs when `config.events` is enabled.
   * In verbose mode, logs the full data; otherwise logs the summary.
   */
  event(prefix: string, label: string, data: unknown, summary?: Record<string, unknown>): void {
    if (!this.config.events) return;
    if (this.config.verbose) {
      console.debug(`[${prefix}] ${label}`, typeof data === "string" ? data : JSON.stringify(data));
    } else {
      console.debug(`[${prefix}] ${label}`, summary ?? data);
    }
  }

  /**
   * Log a lifecycle-level debug message.
   * Only logs when `config.lifecycle` is enabled.
   */
  lifecycle(prefix: string, label: string, data?: Record<string, unknown>): void {
    if (!this.config.lifecycle) return;
    if (data) {
      console.debug(`[${prefix}] ${label}`, data);
    } else {
      console.debug(`[${prefix}] ${label}`);
    }
  }

  /** Whether event-level logging is enabled. */
  get eventsEnabled(): boolean {
    return this.config.events;
  }

  /** Whether lifecycle-level logging is enabled. */
  get lifecycleEnabled(): boolean {
    return this.config.lifecycle;
  }

  /** Whether any logging is enabled. */
  get enabled(): boolean {
    return this.config.enabled;
  }
}

/**
 * Creates a DebugLogger if debug is enabled, otherwise returns undefined.
 * This allows consumers to pass it around cheaply when debug is off.
 */
export function createDebugLogger(config: ResolvedAgentDebugConfig): DebugLogger | undefined {
  return config.enabled ? new DebugLogger(config) : undefined;
}
