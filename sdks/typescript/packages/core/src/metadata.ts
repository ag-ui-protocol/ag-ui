import type { Metadata } from "./generated/types";

/**
 * The key reserved for AG-UI's own use inside a metadata object. Every other
 * key is user space.
 *
 * Reservation is by convention: nothing rejects a write to this key at runtime,
 * because metadata is open by key and validating its shape would contradict
 * that.
 */
export const AGUI_METADATA_KEY = "ag-ui";

/**
 * Extra information attached to an event or a message.
 *
 * Open by key — any JSON value is allowed under a key, including `null`.
 *
 * Deliberately `z.any()` rather than a recursive JSON-value schema, which review
 * has suggested more than once. Two reasons. Every dynamic payload in the
 * protocol uses the permissive form — `state`, `rawEvent`, `CustomEvent.value`,
 * `ActivityMessage.content`, and the pre-existing `Tool.metadata` and
 * `Interrupt.metadata` — so tightening this one field would make it the sole
 * outlier while fixing nothing elsewhere. And a recursive validation would walk
 * every value on every event, on the streaming hot path, to catch a mistake
 * (a function, a bigint) that already fails loudly at encode time.
 *
 * The schema itself now lives in the generated source (MetadataSchema in
 * src/generated/schemas.ts); this comment survives as the recorded reasoning.
 */
/**
 * How metadata is declared on events and messages: the object is absent or an
 * object, never `null`. The validator pinning that invariant is
 * `OptionalMetadataSchema`, which lives in src/schemas.ts along with every
 * other runtime validator this package ships.
 */

/**
 * Whether `metadata` marks a tool call as aborted: cut off by a backend or
 * subagent failure before its arguments were complete, and never to be run.
 *
 * A producer that closes such a call with `TOOL_CALL_END` sets
 * `metadata["ag-ui"].aborted` to `true` on that event. It merges into the tool
 * call like any other tool-call metadata, so the marker survives into
 * `MESSAGES_SNAPSHOT` and replay. Pass it either the `TOOL_CALL_END` event's
 * metadata or the tool call's merged metadata.
 *
 * An aborted call keeps whatever raw arguments arrived. They are diagnostics,
 * not a valid payload, and an aborted call is not an action awaiting client
 * execution. A call that is merely waiting (suspended on an interrupt) is not
 * aborted and must not carry the marker.
 */
export function isAbortedToolCall(metadata: Metadata | undefined): boolean {
  const namespace = metadata?.[AGUI_METADATA_KEY];
  return (
    typeof namespace === "object" &&
    namespace !== null &&
    (namespace as Record<string, unknown>).aborted === true
  );
}

/**
 * Folds `incoming` metadata into `existing`, key by key, with the last write
 * winning.
 *
 * A message is assembled from a sequence of events, and the interesting values
 * — token usage and finish reason among them — are only known at the end. So
 * metadata accumulates as the sequence arrives rather than being fixed at the
 * start.
 *
 * A key's value is replaced outright. This never recurses, so an array or
 * object under any key — including {@link AGUI_METADATA_KEY} — is replaced
 * wholesale rather than blended with what was there before.
 *
 * Returns a new object rather than mutating either argument. An absent
 * `incoming` returns `existing` untouched; an empty `incoming` changes nothing.
 */
export function mergeMetadata(
  existing: Metadata | undefined,
  incoming: Metadata | undefined,
): Metadata | undefined {
  if (incoming === undefined) {
    return existing;
  }
  if (existing === undefined) {
    return { ...incoming };
  }
  return { ...existing, ...incoming };
}
