/** The part of a JSON Patch operation that is safe to log. */
type PatchOperation = { readonly op: string; readonly path: string };

const operationCount = (count: number): string =>
  count === 1 ? "1 operation" : `${count} operations`;

/**
 * A log-safe description of a JSON Patch that failed to apply.
 *
 * `fast-json-patch` builds its error message from the whole document (`tree`)
 * and the failing operation, value included. State and activity content can
 * hold user data, so this keeps only the first line of the message and the
 * failing operation's `op` and `path`. It never includes a value, the
 * document, or every path: JSON Pointer keys can themselves be user data.
 *
 * The position comes from `error.operation`, which is the patch entry itself.
 * `error.index` is not used because it is 0 for every path error the
 * validator raises, whichever operation failed.
 *
 * @param patch The patch that was applied. Not trusted to be an array, since
 *   the public entry points take raw events.
 * @param error What the apply threw. Anything other than an `Error` is not
 *   echoed: the same `try` covers code besides the patch itself.
 */
export function describePatchFailure(patch: unknown, error: unknown): string {
  const operations: readonly PatchOperation[] = Array.isArray(patch) ? patch : [];
  const reason =
    error instanceof Error ? error.message.split("\n", 1)[0] : "non-Error value thrown";
  const failed = (error as { operation?: Partial<PatchOperation> } | null)?.operation;
  if (typeof failed?.op !== "string" || typeof failed.path !== "string") {
    return `${reason} (${operationCount(operations.length)})`;
  }
  // Identity first, so a patch that repeats an op and path still points at
  // the entry that failed; op and path for a caller that passed a copy.
  const byIdentity = operations.indexOf(failed as PatchOperation);
  const index =
    byIdentity >= 0
      ? byIdentity
      : operations.findIndex((op) => op.op === failed.op && op.path === failed.path);
  const where = index >= 0 ? `operation ${index + 1} of ${operations.length}` : "operation";
  return `${reason} (${where}: ${failed.op} ${failed.path})`;
}
