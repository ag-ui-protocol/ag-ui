import { AGUIError } from "@ag-ui/core";

/**
 * How many container entries the enforcement stage will walk for ONE event or
 * ONE outgoing input before giving up: every array element, every own key of a
 * described object (known or not) and every own key of a described record
 * counts once. Opaque positions (state, metadata, forwardedProps, rawEvent, …)
 * are not walked, so they cost nothing here.
 *
 * Generous on purpose — a long real thread is far below it. What it exists to
 * stop is a payload large enough that stripping and validating it, zod's issue
 * accumulation included, ties up the process.
 *
 * One total, not a per-container cap as well: no container can exceed the
 * total, and a per-container cap alone would still let nested arrays multiply.
 * No depth limit either: the walk only descends where a schema does, and the
 * generated schemas are not recursive, so their own shape bounds the depth.
 */
export const DEFAULT_MAX_ENFORCED_ENTRIES = 1_000_000;

export interface EnforcementOptions {
  /** Entry budget per event / outgoing input. `Infinity` disables it. */
  maxEntries?: number;
}

/**
 * The one place a budget is judged. A NaN would compare false against every
 * count and silently switch the budget off, and zero or a negative would fail
 * every payload, so both are refused where they enter rather than discovered
 * mid-run.
 */
export function resolveMaxEntries(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_ENFORCED_ENTRIES;
  if (value === Infinity || (Number.isSafeInteger(value) && (value as number) > 0)) {
    return value as number;
  }
  throw new AGUIError(
    `Invalid enforcement entry budget ${String(value)}: expected a positive integer, or Infinity to disable it.`,
  );
}

/** Thrown when a payload has more entries than the enforcement budget allows. */
export class AGUIEnforcementLimitError extends AGUIError {
  readonly limit: number;
  readonly path: string;

  constructor(limit: number, path: string) {
    super(
      `Enforcement limit exceeded at '${path || "(root)"}': the payload has more than ${limit} entries to validate. If it is legitimate, raise or disable the limit (maxEnforcedEntries on the agent, or maxEntries in the enforcement options).`,
    );
    this.name = "AGUIEnforcementLimitError";
    this.limit = limit;
    this.path = path;
  }
}
