import type { AgentToRendererMessage } from "@a2ui/web_core/v1_0";
import {
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  EventType,
} from "@ag-ui/client";

import { A2uiMcpError } from "./a2ui-messages";
import { A2UI_ACTIVITY_TYPE, type A2uiActivityContent } from "./protocol";

const MESSAGE_ID_PREFIX = "a2ui-surface-";

export function a2uiSnapshot(
  presentationId: string,
  content: A2uiActivityContent,
  source?: ActivitySnapshotEvent,
): ActivitySnapshotEvent {
  return {
    ...source,
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: `${MESSAGE_ID_PREFIX}${presentationId}`,
    activityType: A2UI_ACTIVITY_TYPE,
    content: { ...content },
    replace: true,
  };
}

export function a2uiDelta(
  presentationId: string,
  operations: AgentToRendererMessage[],
): ActivityDeltaEvent {
  return {
    type: EventType.ACTIVITY_DELTA,
    messageId: `${MESSAGE_ID_PREFIX}${presentationId}`,
    activityType: A2UI_ACTIVITY_TYPE,
    patch: operations.map((operation) => ({
      op: "add",
      path: "/a2ui_operations/-",
      value: operation,
    })),
  };
}

export function errorDelta(
  presentationId: string,
  error: unknown,
): ActivityDeltaEvent {
  return {
    type: EventType.ACTIVITY_DELTA,
    messageId: `${MESSAGE_ID_PREFIX}${presentationId}`,
    activityType: A2UI_ACTIVITY_TYPE,
    patch: [
      {
        op: "add",
        path: "/error",
        value: errorMessage(
          error,
          "The A2UI action result could not be applied.",
        ),
      },
    ],
  };
}

export function errorSnapshot(
  presentationId: string,
  resourceUri: string,
  error: unknown,
  source?: ActivitySnapshotEvent,
): ActivitySnapshotEvent {
  const message = errorMessage(
    error,
    `The A2UI resource ${resourceUri} could not be rendered.`,
  );
  return a2uiSnapshot(
    presentationId,
    { a2ui_operations: [], error: message },
    source,
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof A2uiMcpError ? error.message : fallback;
}
