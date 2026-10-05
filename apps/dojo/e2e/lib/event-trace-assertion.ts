import type { TraceEvent } from "./event-trace-events";

type JourneyComparator = (
  actual: readonly TraceEvent[],
  expected: readonly TraceEvent[],
) => void | Promise<void>;

export function withEventTraceAssertion(
  compare: JourneyComparator,
  assertCaptured?: (actual: readonly TraceEvent[]) => void | Promise<void>,
) {
  return async (
    actual: readonly TraceEvent[],
    expected: readonly TraceEvent[],
  ) => {
    await assertCaptured?.(actual);
    await compare(actual, expected);
  };
}
