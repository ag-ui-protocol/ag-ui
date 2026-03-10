/** Log prefix used for adapter runtime logs. */
const SCOPE = 'Mastra Agui';

/** Common logger function signature. */
type LogFn = (event: string, payload?: Record<string, unknown>) => void;

/** Logger contract used by the adapter and registry layers. */
export interface AgentLogger {
  /** Debug-level log output. */
  debug: LogFn;
  /** Info-level log output. */
  info: LogFn;
  /** Warn-level log output. */
  warn: LogFn;
  /** Error-level log output. */
  error: LogFn;
}

/** No-op logger implementation for disabled logging mode. */
const noop: LogFn = () => {};

/** Builds a console logger bound to a specific severity level. */
const mk =
  (level: 'debug' | 'info' | 'warn' | 'error'): LogFn =>
  (event, payload) => {
    console.log('');
    if (payload !== undefined) console[level](`[ ${SCOPE} ] ${event}`, payload);
    else console[level](`[ ${SCOPE} ] ${event}`);
    console.log('');
  };

/** Logger used when debug mode is disabled. */
const noopLogger: AgentLogger = { debug: noop, info: noop, warn: noop, error: noop };

/** Logger used when debug mode is enabled. */
const consoleLogger: AgentLogger = {
  debug: mk('debug'),
  info: mk('info'),
  warn: mk('warn'),
  error: mk('error'),
};

/**
 * Returns the adapter logger according to debug flag.
 * Pass `AbstractAgent.debug` to toggle console output.
 * @param debug Whether console logging is enabled.
 */
export function createAgentLogger(debug?: boolean): AgentLogger {
  return debug ? consoleLogger : noopLogger;
}
