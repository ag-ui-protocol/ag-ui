import { EventType, MessagesSnapshotEvent } from "@ag-ui/core";
import { authoritativeActivityTypes, withAuthoritativeActivityTypes } from "./activity-history";

const snapshot = (metadata?: MessagesSnapshotEvent["metadata"]): MessagesSnapshotEvent => ({
  type: EventType.MESSAGES_SNAPSHOT,
  messages: [{ id: "foreign", role: "activity", activityType: "foreign", content: {} }],
  ...(metadata === undefined ? {} : { metadata }),
});

describe("activity history authority", () => {
  it.each([undefined, {}, { trace: "keep" }, { "@ag-ui/client": { otherKey: 123 } }])(
    "uses legacy inference when the namespace or field is absent: %j",
    (metadata) => {
      expect(authoritativeActivityTypes(snapshot(metadata))).toBeUndefined();
    },
  );

  it.each([{ scope: null }, { scope: [] }, { scope: ["owned"] }])(
    "reads explicit scope $scope",
    ({ scope }) => {
      expect(
        authoritativeActivityTypes(
          snapshot({ "@ag-ui/client": { authoritativeActivityTypes: scope } }),
        ),
      ).toEqual(scope);
    },
  );

  it.each(
    [
      undefined,
      null,
      false,
      "invalid",
      [],
      { authoritativeActivityTypes: undefined },
      { authoritativeActivityTypes: "owned" },
      { authoritativeActivityTypes: ["owned", 5] },
    ].map((declaration) => ({ declaration })),
  )(
    "grants no deletion authority for a present invalid declaration: $declaration",
    ({ declaration }) => {
      const event = snapshot({ "@ag-ui/client": declaration });
      expect(authoritativeActivityTypes(event)).toEqual([]);
      expect(
        authoritativeActivityTypes(withAuthoritativeActivityTypes(event, ["projected"])),
      ).toEqual(["projected"]);
    },
  );

  it("unions scopes without mutating input messages, scopes or metadata", () => {
    const scope = ["first"];
    const event = snapshot({
      trace: { id: "trace" },
      "ag-ui": { reserved: true },
      "@ag-ui/client": { other: "keep", authoritativeActivityTypes: scope },
    });
    const before = structuredClone(event);
    const requested = Object.freeze(["second", "first"]);
    Object.freeze(scope);
    Object.freeze(event.metadata?.["@ag-ui/client"]);
    Object.freeze(event.metadata);
    Object.freeze(event.messages);
    Object.freeze(event);
    const extended = withAuthoritativeActivityTypes(event, requested);
    expect(extended).toEqual({
      ...event,
      metadata: {
        ...event.metadata,
        "@ag-ui/client": { other: "keep", authoritativeActivityTypes: ["first", "second"] },
      },
    });
    expect(extended.messages).toBe(event.messages);
    expect(event).toEqual(before);
    expect(withAuthoritativeActivityTypes(extended, requested)).toEqual(extended);
  });

  it.each([{ messages: [] }, { messages: snapshot().messages }])(
    "preserves explicit full authority with messages %j",
    ({ messages }) => {
      const event = {
        ...snapshot({ "@ag-ui/client": { authoritativeActivityTypes: null } }),
        messages,
      };
      expect(
        authoritativeActivityTypes(withAuthoritativeActivityTypes(event, ["projected"])),
      ).toBeNull();
    },
  );

  it("preserves inferred full authority from the original unmarked activity snapshot", () => {
    expect(
      authoritativeActivityTypes(withAuthoritativeActivityTypes(snapshot(), ["projected"])),
    ).toBeNull();
  });

  it("adds only projector scope to an unmarked transcript before replacing messages", () => {
    const event: MessagesSnapshotEvent = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "u", role: "user", content: "hello" }],
    };
    const projected = {
      ...withAuthoritativeActivityTypes(event, ["projected"]),
      messages: snapshot().messages,
    };
    expect(authoritativeActivityTypes(projected)).toEqual(["projected"]);
    expect(event.metadata).toBeUndefined();
  });

  it("extends an explicit empty scope despite activity in the snapshot", () => {
    expect(
      authoritativeActivityTypes(
        withAuthoritativeActivityTypes(
          snapshot({ "@ag-ui/client": { authoritativeActivityTypes: [] } }),
          ["projected"],
        ),
      ),
    ).toEqual(["projected"]);
  });
});
