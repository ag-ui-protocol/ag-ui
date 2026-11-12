import { getOperationSurfaceId, isRecord } from "./schema";

/**
 * Merging a tool result's operations into an already painted activity.
 *
 * An `a2ui-surface` activity is rendered on its own: a fresh renderer replays
 * exactly the operations the activity carries. An adapter's canonical result
 * for an update is intentionally update-only, so folding it into the activity
 * must keep the surface's creation (catalog, version, metadata, data-model
 * settings) and replace only what the result changes.
 */

export type A2UIOperationRecord = Record<string, unknown>;

export interface PaintedActivity {
  /** Operations in `content.a2ui_operations`, ignoring malformed entries. */
  operations: A2UIOperationRecord[];
  /** The other content keys the adapter stamped (e.g. `inferenceFormat`). */
  wrapper: Record<string, unknown>;
}

/** Split an activity's content into its operations and wrapper, or null for a lifecycle state. */
export function readPaintedActivity(content: unknown): PaintedActivity | null {
  if (!isRecord(content)) return null;
  const { a2ui_operations: raw, ...wrapper } = content;
  if (!Array.isArray(raw)) return null;
  return { operations: raw.filter(isRecord), wrapper };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRootDataPath(path: unknown): boolean {
  return path === undefined || path === "" || path === "/";
}

/** Canonical form for equality: an omitted data-model path means the root. */
function canonicalOperation(op: A2UIOperationRecord): A2UIOperationRecord {
  const body = op.updateDataModel;
  if (isRecord(body) && isRootDataPath(body.path)) {
    return { ...op, updateDataModel: { ...body, path: "/" } };
  }
  return op;
}

/** True when both operation lists paint the same thing. */
export function sameOperations(
  a: A2UIOperationRecord[],
  b: A2UIOperationRecord[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (op, index) =>
        stableStringify(canonicalOperation(op)) ===
        stableStringify(canonicalOperation(b[index])),
    )
  );
}

/**
 * Apply `incoming` operations for one surface onto a retained snapshot.
 *
 * - `createSurface` is kept from the retained snapshot; an incoming one is only
 *   inserted (ahead of the surface's other operations) when none was painted.
 * - `updateComponents` replaces the retained component set.
 * - A root `updateDataModel` replaces the retained data model; a sub-path
 *   update is applied after it, as it would be on a live surface.
 * - `deleteSurface` and anything else are appended after the surface's
 *   operations, so a replay creates and then deletes rather than deleting
 *   something that never existed.
 *
 * Operations for other surfaces keep their positions.
 */
export function mergeSurfaceOperations(
  retained: A2UIOperationRecord[],
  surfaceId: string,
  incoming: A2UIOperationRecord[],
): A2UIOperationRecord[] {
  const merged = [...retained];
  const targets = (op: A2UIOperationRecord) =>
    getOperationSurfaceId(op) === surfaceId;
  const indexOf = (kind: string) =>
    merged.findIndex((op) => targets(op) && kind in op);
  const afterLast = () => {
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (targets(merged[index])) return index + 1;
    }
    return merged.length;
  };
  const replaceKind = (kind: string, op: A2UIOperationRecord, at: number) => {
    const index = indexOf(kind);
    if (index < 0) {
      merged.splice(at, 0, op);
      return;
    }
    merged[index] = op;
    for (let later = merged.length - 1; later > index; later -= 1) {
      if (targets(merged[later]) && kind in merged[later]) {
        merged.splice(later, 1);
      }
    }
  };

  for (const op of incoming) {
    if ("createSurface" in op) {
      // The painted creation owns the catalog, version and surface settings
      // (sendDataModel, metadata, theme); a result's creation only fills a gap.
      if (indexOf("createSurface") < 0) {
        const first = merged.findIndex(targets);
        merged.splice(first >= 0 ? first : merged.length, 0, op);
      }
    } else if ("updateComponents" in op) {
      const create = indexOf("createSurface");
      replaceKind(
        "updateComponents",
        op,
        create >= 0 ? create + 1 : afterLast(),
      );
    } else if ("updateDataModel" in op) {
      const body = op.updateDataModel;
      if (isRecord(body) && isRootDataPath(body.path)) {
        replaceKind("updateDataModel", op, afterLast());
      } else {
        merged.splice(afterLast(), 0, op);
      }
    } else {
      merged.splice(afterLast(), 0, op);
    }
  }
  return merged;
}
