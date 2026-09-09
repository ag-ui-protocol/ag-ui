import { MessagesSnapshotEvent } from "@ag-ui/core";

/** Package-owned convention. The protocol-reserved `ag-ui` namespace is untouched. */
export const ACTIVITY_HISTORY_METADATA = "@ag-ui/client";

export function authoritativeActivityTypes(event: MessagesSnapshotEvent): string[] | undefined {
  const value = event.metadata?.[ACTIVITY_HISTORY_METADATA];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const types = (value as Record<string, unknown>).authoritativeActivityTypes;
  return Array.isArray(types) && types.every((type): type is string => typeof type === "string")
    ? types
    : undefined;
}

/** Add one projector's authoritative scope without replacing other owners' metadata. */
export function withAuthoritativeActivityTypes(
  event: MessagesSnapshotEvent,
  activityTypes: readonly string[],
): MessagesSnapshotEvent {
  const prior = event.metadata?.[ACTIVITY_HISTORY_METADATA];
  return {
    ...event,
    metadata: {
      ...event.metadata,
      [ACTIVITY_HISTORY_METADATA]: {
        ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}),
        authoritativeActivityTypes: [
          ...new Set([...(authoritativeActivityTypes(event) ?? []), ...activityTypes]),
        ],
      },
    },
  };
}
