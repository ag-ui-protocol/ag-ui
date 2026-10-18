import { MessagesSnapshotEvent } from "@ag-ui/core";

/** Package-owned convention. The protocol-reserved `ag-ui` namespace is untouched. */
export const ACTIVITY_HISTORY_METADATA = "@ag-ui/client";

/**
 * Null owns all types; arrays own their types. Absent declarations use legacy
 * inference, while invalid declarations grant no omission-based deletion.
 */
export function authoritativeActivityTypes(
  event: MessagesSnapshotEvent,
): string[] | null | undefined {
  if (
    !event.metadata ||
    !Object.prototype.hasOwnProperty.call(event.metadata, ACTIVITY_HISTORY_METADATA)
  )
    return undefined;
  const value = event.metadata?.[ACTIVITY_HISTORY_METADATA];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (!Object.prototype.hasOwnProperty.call(value, "authoritativeActivityTypes")) return undefined;
  const types = (value as Record<string, unknown>).authoritativeActivityTypes;
  if (types === null) return null;
  return Array.isArray(types) && types.every((type): type is string => typeof type === "string")
    ? types
    : [];
}

/**
 * Add a projector scope, preserving full authority. Call on the incoming snapshot
 * before replacing its messages so inferred authority describes the original set.
 */
export function withAuthoritativeActivityTypes(
  event: MessagesSnapshotEvent,
  activityTypes: readonly string[],
): MessagesSnapshotEvent {
  const prior = event.metadata?.[ACTIVITY_HISTORY_METADATA];
  const scope = authoritativeActivityTypes(event);
  const ownsAll =
    scope === null ||
    (scope === undefined && event.messages.some((message) => message.role === "activity"));
  return {
    ...event,
    metadata: {
      ...event.metadata,
      [ACTIVITY_HISTORY_METADATA]: {
        ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
        authoritativeActivityTypes: ownsAll
          ? null
          : [...new Set([...(scope ?? []), ...activityTypes])],
      },
    },
  };
}
