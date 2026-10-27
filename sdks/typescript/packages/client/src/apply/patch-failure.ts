/** The part of a JSON Patch operation that is safe to log. */
type PatchOperation = { readonly op: string; readonly path: string };

/**
 * A log-safe description of a JSON Patch that failed to apply.
 *
 * `fast-json-patch` builds its error message from the whole document (`tree`)
 * and the failing operation, value included. State and activity content can
 * hold user data, so this keeps only the first line of the message and the
 * failing operation's `op` and `path`. It never includes a value, the
 * document, or every path: JSON Pointer keys can themselves be user data.
 *
 * The failing operation comes from `error.operation`, not `error.index`: with
 * validation on, `index` refers to a one-operation check and is always 0.
 */
export function describePatchFailure(patch: readonly PatchOperation[], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason = message.split("\n", 1)[0];
  const failed = (error as { operation?: Partial<PatchOperation> } | null)?.operation;
  if (typeof failed?.op !== "string" || typeof failed.path !== "string") {
    return `${reason} (${patch.length} operations)`;
  }
  // The error holds a copy of the operation, so match it by op and path.
  const position = patch.findIndex((op) => op.op === failed.op && op.path === failed.path);
  const where = position >= 0 ? `operation ${position + 1} of ${patch.length}` : "operation";
  return `${reason} (${where}: ${failed.op} ${failed.path})`;
}
