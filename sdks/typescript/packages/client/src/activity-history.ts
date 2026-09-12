import { MessagesSnapshotEvent } from "@ag-ui/core";

/** Package-owned convention. The protocol-reserved `ag-ui` namespace is untouched. */
export const ACTIVITY_HISTORY_METADATA = "@ag-ui/client";

/** Null owns all types, an array owns its types, and absent metadata uses legacy inference. */
export function authoritativeActivityTypes(
  event: MessagesSnapshotEvent,
): string[] | null | undefined {
  const value = event.metadata?.[ACTIVITY_HISTORY_METADATA];
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const types = (value as Record<string, unknown>).authoritativeActivityTypes;
  if (types === null) return null;
  return Array.isArray(types) &&
    types.every((type): type is string => typeof type === "string")
    ? types
    : undefined;
}

/** Add a projector scope, preserving full authority. Null owns all activity types. */
export function withAuthoritativeActivityTypes(
  event: MessagesSnapshotEvent,
  activityTypes: readonly string[],
): MessagesSnapshotEvent {
  const prior = event.metadata?.[ACTIVITY_HISTORY_METADATA];
  const scope = authoritativeActivityTypes(event);
  const ownsAll =
    scope === null ||
    (scope === undefined &&
      event.messages.some((message) => message.role === "activity"));
  return {
    ...event,
    metadata: {
      ...event.metadata,
      [ACTIVITY_HISTORY_METADATA]: {
        ...(prior && typeof prior === "object" && !Array.isArray(prior)
          ? prior
          : {}),
        authoritativeActivityTypes: ownsAll
          ? null
          : [...new Set([...(scope ?? []), ...activityTypes])],
      },
    },
  };
}
