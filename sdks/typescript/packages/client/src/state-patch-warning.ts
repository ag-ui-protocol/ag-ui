/**
 * Describes a JSON Patch that failed to apply, for a warning, without its
 * contents. Agent state often holds user data, and fast-json-patch's error
 * `message` embeds the whole document (`tree`) and the failing operation
 * (with its `value`), so the state, the operation values and the raw error
 * message are all left out. What remains is the number of operations, each
 * operation's kind and path, and the error's name and first line.
 *
 * Internal: deliberately not re-exported from the package entry point.
 */
export function describeFailedStatePatch(delta: unknown, error: unknown): string {
  const operations = Array.isArray(delta) ? delta : [];
  const described = operations.map((operation) => {
    const { op, path, from } = (operation ?? {}) as {
      op?: unknown;
      path?: unknown;
      from?: unknown;
    };
    const kind = typeof op === "string" ? op : "?";
    const target = typeof path === "string" ? path : "?";
    return typeof from === "string" ? `${kind} ${from} -> ${target}` : `${kind} ${target}`;
  });

  let reason = "non-Error value thrown";
  if (error instanceof Error) {
    const firstLine = error.message.split("\n")[0];
    reason = error.name && error.name !== "Error" ? `${error.name}: ${firstLine}` : firstLine;
    const { index } = error as { index?: unknown };
    if (typeof index === "number") {
      reason += ` (operation ${index})`;
    }
  }

  return `${operations.length} operation(s) [${described.join(", ")}]; ${reason}`;
}
