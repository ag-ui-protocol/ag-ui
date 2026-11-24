import { type ActivitySnapshotEvent, EventType } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import { a2uiSnapshot, errorSnapshot } from "../src/a2ui/activity-snapshots";

const source: ActivitySnapshotEvent = {
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId: "mcp-apps-1",
  activityType: "mcp-apps",
  content: { resourceUri: "a2ui://customer-details" },
  replace: true,
  timestamp: 1763900000000,
  rawEvent: { correlationId: "c-1" },
};

describe("A2UI activity snapshots", () => {
  it("keeps the metadata of the source snapshot", () => {
    const snapshot = a2uiSnapshot("call-1", { a2ui_operations: [] }, source);

    expect(snapshot).toEqual({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "a2ui-surface-call-1",
      activityType: "a2ui-surface-v1",
      content: { a2ui_operations: [] },
      replace: true,
      timestamp: 1763900000000,
      rawEvent: { correlationId: "c-1" },
    });
  });

  it("keeps the metadata of the source snapshot for errors", () => {
    const snapshot = errorSnapshot(
      "call-1",
      "a2ui://customer-details",
      new Error("boom"),
      source,
    );

    expect(snapshot).toMatchObject({
      messageId: "a2ui-surface-call-1",
      timestamp: 1763900000000,
      rawEvent: { correlationId: "c-1" },
      content: {
        a2ui_operations: [],
        error:
          "The A2UI resource a2ui://customer-details could not be rendered.",
      },
    });
  });
});
