import { describe, expect, it } from "vitest";
import {
  ActivitySnapshotEvent,
  BaseEvent,
  EventType,
  ToolCallResultEvent,
} from "@ag-ui/client";
import {
  A2UIActivityType,
  A2UIMiddleware,
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
  getOperationSurfaceId,
} from "../src";
import { MockAgent, collectEvents, createRunAgentInput } from "./test-utils";
import v1Catalog from "./fixtures/a2ui-1.0-basic-catalog.json";
import adkExpressLive from "./fixtures/adk-express-1.0-live.json";

/**
 * Adapters that render without a streamed nested call (the ADK Express path)
 * emit their own complete `a2ui-surface` activity, then return the canonical
 * envelope as the wrapper's tool result. For an update that canonical result is
 * intentionally update-only. The middleware must not replace the complete
 * activity with that delta: every activity it leaves behind has to replay into
 * a fresh renderer on its own.
 */

const V1_CATALOG_ID =
  "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
const V0_9_CATALOG_ID =
  "https://a2ui.org/specification/v0_9/basic_catalog.json";
const SURFACE = "validation-surface";

const v1Components = [
  { id: "heading", component: "Text", text: { "@path": "/title" } },
  { id: "row", component: "Text", text: { "@path": "name" } },
  {
    id: "items",
    component: "List",
    children: { componentId: "row", path: "/items" },
  },
  { id: "root", component: "Column", children: ["heading", "items"] },
];
const v09Components = [
  { id: "heading", component: "Text", text: { path: "/title" } },
  { id: "row", component: "Text", text: { path: "name" } },
  {
    id: "items",
    component: "List",
    children: { componentId: "row", path: "/items" },
  },
  { id: "root", component: "Column", children: ["heading", "items"] },
];
const updatedData = {
  title: "CPK187_UPDATED",
  items: [{ name: "Gamma" }, { name: "Delta" }],
};

const v1Create = {
  version: "1.0",
  createSurface: {
    surfaceId: SURFACE,
    catalogId: V1_CATALOG_ID,
    sendDataModel: true,
    metadata: { extensions: { source: "adk-update-validation" } },
  },
};
const v09Create = {
  version: "v0.9",
  createSurface: {
    surfaceId: SURFACE,
    catalogId: V0_9_CATALOG_ID,
    theme: { primaryColor: "#123456" },
  },
};
const components = (version: string, list: unknown, surfaceId = SURFACE) => ({
  version,
  updateComponents: { surfaceId, components: list },
});
const data = (version: string, value: unknown, surfaceId = SURFACE) => ({
  version,
  updateDataModel: { surfaceId, path: "/", value },
});

const completeV1 = [
  v1Create,
  components("1.0", v1Components),
  data("1.0", updatedData),
];
const updateOnlyV1 = [
  components("1.0", v1Components),
  data("1.0", updatedData),
];
const completeV09 = [
  v09Create,
  components("v0.9", v09Components),
  data("v0.9", updatedData),
];
const updateOnlyV09 = [
  components("v0.9", v09Components),
  data("v0.9", updatedData),
];

function activity(
  callId: string,
  content: Record<string, unknown>,
): ActivitySnapshotEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: `a2ui-surface-${callId}`,
    activityType: A2UIActivityType,
    content,
    replace: true,
  };
}

const expressPaint = (callId: string, ops: unknown[]) =>
  activity(callId, { a2ui_operations: ops, inferenceFormat: "express" });

/** The ADK Express contract: wrapper call → its own activity → canonical result. */
function expressCall(options: {
  callId: string;
  toolName?: string;
  activities: BaseEvent[];
  result: unknown;
}): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: options.callId,
      toolCallName: options.toolName ?? "generate_a2ui",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: options.callId,
      delta: '{"intent":"update","target_surface_id":"validation-surface"}',
    },
    { type: EventType.TOOL_CALL_END, toolCallId: options.callId },
    ...options.activities,
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: `result-${options.callId}`,
      toolCallId: options.callId,
      content:
        typeof options.result === "string"
          ? options.result
          : JSON.stringify(options.result),
    },
  ] as BaseEvent[];
}

const wrap = (events: BaseEvent[]): BaseEvent[] => [
  {
    type: EventType.RUN_STARTED,
    runId: "run",
    threadId: "thread",
  } as BaseEvent,
  ...events,
  {
    type: EventType.RUN_FINISHED,
    runId: "run",
    threadId: "thread",
  } as BaseEvent,
];

async function run(
  events: BaseEvent[],
  catalog: Record<string, unknown> = v1Catalog,
) {
  const middleware = new A2UIMiddleware({
    defaultCatalogId: catalog.catalogId as string,
  });
  return collectEvents(
    middleware.run(
      createRunAgentInput({
        context: [
          {
            description: A2UI_SCHEMA_CONTEXT_DESCRIPTION,
            value: JSON.stringify(catalog),
          },
        ],
      }),
      new MockAgent(events),
    ),
  );
}

const isPaint = (event: BaseEvent): event is ActivitySnapshotEvent =>
  event.type === EventType.ACTIVITY_SNAPSHOT &&
  Array.isArray((event as ActivitySnapshotEvent).content?.a2ui_operations);
const opsOf = (event: ActivitySnapshotEvent) =>
  event.content.a2ui_operations as Array<Record<string, unknown>>;

function lastSnapshot(output: BaseEvent[], messageId: string) {
  const snapshots = output.filter(
    (event): event is ActivitySnapshotEvent =>
      event.type === EventType.ACTIVITY_SNAPSHOT &&
      (event as ActivitySnapshotEvent).messageId === messageId,
  );
  expect(snapshots.length).toBeGreaterThan(0);
  return snapshots[snapshots.length - 1];
}

function paintsAfterResult(output: BaseEvent[], toolCallId: string) {
  const index = output.findIndex(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT &&
      (event as ToolCallResultEvent).toolCallId === toolCallId,
  );
  expect(index).toBeGreaterThan(-1);
  return output.slice(index + 1).filter(isPaint);
}

/**
 * Every painted activity must create each surface it updates. This is the
 * property a fresh renderer needs: replaying the activity alone must not hit
 * "Surface not found".
 */
function expectSelfContained(output: BaseEvent[]) {
  for (const paint of output.filter(isPaint)) {
    const created = new Set<string>();
    for (const op of opsOf(paint)) {
      const surfaceId = getOperationSurfaceId(op);
      if (op.createSurface && surfaceId) created.add(surfaceId);
      if (
        (op.updateComponents || op.updateDataModel || op.deleteSurface) &&
        surfaceId
      ) {
        expect(
          created.has(surfaceId),
          `activity ${paint.messageId} updates "${surfaceId}" without creating it first: ${JSON.stringify(opsOf(paint))}`,
        ).toBe(true);
      }
    }
  }
}

describe("Express complete activity followed by an update-only final result", () => {
  it.each([
    ["1.0", v1Catalog, completeV1, updateOnlyV1, v1Create],
    [
      "0.9",
      { ...v1Catalog, catalogId: V0_9_CATALOG_ID, protocolVersion: "0.9" },
      completeV09,
      updateOnlyV09,
      v09Create,
    ],
  ])(
    "keeps the complete activity and its creation settings (%s)",
    async (_label, catalog, complete, updateOnly, create) => {
      const output = await run(
        wrap(
          expressCall({
            callId: "call-update",
            activities: [expressPaint("call-update", complete)],
            result: { a2ui_operations: updateOnly },
          }),
        ),
        catalog as Record<string, unknown>,
      );

      const final = lastSnapshot(output, "a2ui-surface-call-update");
      const ops = opsOf(final);
      expect(ops[0]).toEqual(create);
      expect(ops.slice(1)).toEqual(updateOnly);
      // Adapter wrapper keys survive alongside the operations.
      expect(final.content.inferenceFormat).toBe("express");
      expectSelfContained(output);
    },
  );

  it("suppresses the redundant repaint instead of replacing the activity with a delta", async () => {
    const output = await run(
      wrap(
        expressCall({
          callId: "call-update",
          activities: [expressPaint("call-update", completeV1)],
          result: { a2ui_operations: updateOnlyV1 },
        }),
      ),
    );
    expect(paintsAfterResult(output, "call-update")).toHaveLength(0);
    expectSelfContained(output);
  });

  it("forwards the canonical update-only tool result unchanged", async () => {
    const content = JSON.stringify({ a2ui_operations: updateOnlyV1 });
    const output = await run(
      wrap(
        expressCall({
          callId: "call-update",
          activities: [expressPaint("call-update", completeV1)],
          result: content,
        }),
      ),
    );
    const forwarded = output.find(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT &&
        (event as ToolCallResultEvent).toolCallId === "call-update",
    ) as ToolCallResultEvent;
    expect(forwarded.content).toBe(content);
    expect(forwarded.messageId).toBe("result-call-update");
  });

  it("applies a final result that differs from the activity onto the retained creation", async () => {
    const finalData = { title: "CPK187_FINAL", items: [{ name: "Epsilon" }] };
    const output = await run(
      wrap(
        expressCall({
          callId: "call-update",
          activities: [expressPaint("call-update", completeV1)],
          result: {
            a2ui_operations: [
              components("1.0", v1Components),
              data("1.0", finalData),
            ],
          },
        }),
      ),
    );
    const after = paintsAfterResult(output, "call-update");
    expect(after).toHaveLength(1);
    expect(after[0].messageId).toBe("a2ui-surface-call-update");
    expect(opsOf(after[0])).toEqual([
      v1Create,
      components("1.0", v1Components),
      data("1.0", finalData),
    ]);
    expect(after[0].content.inferenceFormat).toBe("express");
    expectSelfContained(output);
  });

  it("keeps the activity's creation settings when the result carries a bare creation", async () => {
    // The painted creation owns catalog, sendDataModel and metadata; a result
    // that repeats the creation without them must not strip them.
    const finalCreate = {
      version: "1.0",
      createSurface: { surfaceId: SURFACE, catalogId: V1_CATALOG_ID },
    };
    const output = await run(
      wrap(
        expressCall({
          callId: "call-create",
          activities: [expressPaint("call-create", completeV1)],
          result: { a2ui_operations: [finalCreate, ...updateOnlyV1] },
        }),
      ),
    );
    expect(paintsAfterResult(output, "call-create")).toHaveLength(0);
    expect(opsOf(lastSnapshot(output, "a2ui-surface-call-create"))).toEqual(
      completeV1,
    );
    expectSelfContained(output);
  });

  it("keeps a deletion replayable by retaining the creation it deletes", async () => {
    const remove = { version: "1.0", deleteSurface: { surfaceId: SURFACE } };
    const output = await run(
      wrap(
        expressCall({
          callId: "call-delete",
          activities: [expressPaint("call-delete", completeV1)],
          result: { a2ui_operations: [remove] },
        }),
      ),
    );
    const after = paintsAfterResult(output, "call-delete");
    expect(after).toHaveLength(1);
    expect(after[0].messageId).toBe("a2ui-surface-call-delete");
    expect(opsOf(after[0])).toEqual([...completeV1, remove]);
    expectSelfContained(output);
  });

  it("keeps an exhausted-recovery failure authoritative after a complete activity", async () => {
    const output = await run(
      wrap(
        expressCall({
          callId: "call-failed",
          activities: [expressPaint("call-failed", completeV1)],
          result: {
            code: "a2ui_recovery_exhausted",
            error: "Failed to generate valid A2UI after 3 attempt(s)",
            attempts: [{ attempt: 1, ok: false, errors: [] }],
          },
        }),
      ),
    );
    const final = lastSnapshot(output, "a2ui-surface-call-failed");
    expect(final.content.status).toBe("failed");
    expect(final.content.a2ui_operations).toBeUndefined();
  });

  it("paints an unrelated call's surface separately and leaves the activity alone", async () => {
    const other = [
      {
        version: "1.0",
        createSurface: { surfaceId: "other-surface", catalogId: V1_CATALOG_ID },
      },
      components("1.0", v1Components, "other-surface"),
      data("1.0", updatedData, "other-surface"),
    ];
    const output = await run(
      wrap([
        ...expressCall({
          callId: "call-update",
          activities: [expressPaint("call-update", completeV1)],
          result: { a2ui_operations: updateOnlyV1 },
        }),
        ...expressCall({
          callId: "call-other",
          toolName: "search_flights",
          activities: [],
          result: { a2ui_operations: other },
        }),
      ]),
    );
    expect(
      paintsAfterResult(output, "call-update").map((e) => e.messageId),
    ).toEqual(["a2ui-surface-call-other"]);
    expect(opsOf(lastSnapshot(output, "a2ui-surface-call-other"))).toEqual(
      other,
    );
    expect(opsOf(lastSnapshot(output, "a2ui-surface-call-update"))).toEqual(
      completeV1,
    );
    expectSelfContained(output);
  });

  it("scopes final results to their own invocation across parallel calls", async () => {
    const second = "second-surface";
    const completeSecond = [
      {
        version: "1.0",
        createSurface: {
          surfaceId: second,
          catalogId: V1_CATALOG_ID,
          sendDataModel: true,
        },
      },
      components("1.0", v1Components, second),
      data("1.0", updatedData, second),
    ];
    const output = await run(
      wrap([
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-a",
          toolCallName: "generate_a2ui",
          parentMessageId: "assistant-1",
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "call-a" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-b",
          toolCallName: "generate_a2ui",
          parentMessageId: "assistant-1",
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "call-b" },
        expressPaint("call-a", completeV1),
        expressPaint("call-b", completeSecond),
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "result-b",
          toolCallId: "call-b",
          content: JSON.stringify({
            a2ui_operations: [
              components("1.0", v1Components, second),
              data("1.0", updatedData, second),
            ],
          }),
        },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "result-a",
          toolCallId: "call-a",
          content: JSON.stringify({ a2ui_operations: updateOnlyV1 }),
        },
      ] as BaseEvent[]),
    );
    expect(opsOf(lastSnapshot(output, "a2ui-surface-call-a"))).toEqual(
      completeV1,
    );
    expect(opsOf(lastSnapshot(output, "a2ui-surface-call-b"))).toEqual(
      completeSecond,
    );
    expect(paintsAfterResult(output, "call-b")).toHaveLength(0);
    expectSelfContained(output);
  });

  it("merges the known surface and paints a new sibling surface when a result spans both", async () => {
    const sibling = "sibling-surface";
    const siblingOps = [
      {
        version: "1.0",
        createSurface: { surfaceId: sibling, catalogId: V1_CATALOG_ID },
      },
      components("1.0", v1Components, sibling),
    ];
    const output = await run(
      wrap(
        expressCall({
          callId: "call-multi",
          activities: [expressPaint("call-multi", completeV1)],
          result: { a2ui_operations: [...updateOnlyV1, ...siblingOps] },
        }),
      ),
    );
    expect(opsOf(lastSnapshot(output, "a2ui-surface-call-multi"))).toEqual(
      completeV1,
    );
    // The new surface keeps its own per-surface activity id, as multi-surface
    // results always have, and never takes over the wrapper's activity.
    expect(
      opsOf(lastSnapshot(output, `a2ui-surface-${sibling}-call-multi`)),
    ).toEqual(siblingOps);
    expectSelfContained(output);
  });

  it("tracks the latest paint after a retry state replaced an earlier one", async () => {
    const retryData = { title: "RETRY", items: [{ name: "Zeta" }] };
    const retried = [
      v1Create,
      components("1.0", v1Components),
      data("1.0", retryData),
    ];
    const output = await run(
      wrap(
        expressCall({
          callId: "call-retry",
          activities: [
            expressPaint("call-retry", completeV1),
            activity("call-retry", {
              status: "retrying",
              attempt: 2,
              maxAttempts: 3,
              errors: [],
              inferenceFormat: "express",
            }),
            expressPaint("call-retry", retried),
          ],
          result: {
            a2ui_operations: [
              components("1.0", v1Components),
              data("1.0", retryData),
            ],
          },
        }),
      ),
    );
    expect(paintsAfterResult(output, "call-retry")).toHaveLength(0);
    expect(opsOf(lastSnapshot(output, "a2ui-surface-call-retry"))).toEqual(
      retried,
    );
    expectSelfContained(output);
  });

  it("still paints a result when the activity for that call never painted", async () => {
    // An adapter that only sent lifecycle states gets the classic behaviour:
    // the canonical result paints the activity.
    const output = await run(
      wrap(
        expressCall({
          callId: "call-plain",
          activities: [activity("call-plain", { status: "building" })],
          result: { a2ui_operations: completeV1 },
        }),
      ),
    );
    const after = paintsAfterResult(output, "call-plain");
    expect(after).toHaveLength(1);
    expect(after[0].messageId).toBe("a2ui-surface-call-plain");
    expect(opsOf(after[0])).toEqual(completeV1);
  });
});

describe("captured ADK Express 1.0 runs (published CopilotKit 1.87.0 validation)", () => {
  const typed = (events: Array<Record<string, unknown>>) =>
    events.map((event) => {
      const type = Object.values(EventType).find((t) => t === event.type);
      if (!type) throw new Error(`Unknown recorded event type: ${event.type}`);
      return { ...event, type } as BaseEvent;
    });

  it.each(adkExpressLive.runs.map((run) => [run.name, run.events] as const))(
    "leaves a self-contained activity for the %s run",
    async (_name, events) => {
      const output = await run(typed(events as Array<Record<string, unknown>>));
      const call = events.find((event) => event.type === "TOOL_CALL_START") as {
        toolCallId: string;
      };
      const final = lastSnapshot(output, `a2ui-surface-${call.toolCallId}`);
      const ops = opsOf(final);
      const create = ops.find((op) => op.createSurface) as any;
      expect(create).toBeDefined();
      expect(create.version).toBe("1.0");
      expect(create.createSurface.catalogId).toBe(V1_CATALOG_ID);
      expect(create.createSurface.sendDataModel).toBe(true);
      expect(create.createSurface.metadata).toEqual({
        extensions: { source: "adk-update-validation" },
      });
      expect(final.content.inferenceFormat).toBe("express");
      // The canonical result's operations are what the activity ends with.
      const result = events.find(
        (event) => event.type === "TOOL_CALL_RESULT",
      ) as {
        content: string;
      };
      const canonical = JSON.parse(result.content).a2ui_operations as Array<
        Record<string, unknown>
      >;
      for (const op of canonical) {
        expect(ops).toContainEqual(op);
      }
      const forwarded = output.find(
        (event) => event.type === EventType.TOOL_CALL_RESULT,
      ) as ToolCallResultEvent;
      expect(forwarded.content).toBe(result.content);
      expectSelfContained(output);
    },
  );
});

describe("review follow-ups: adapter activities keyed per surface", () => {
  it("resolves final operations against the same call's per-surface activities", async () => {
    const second = "second-surface";
    const completeSecond = [
      {
        version: "1.0",
        createSurface: {
          surfaceId: second,
          catalogId: V1_CATALOG_ID,
          sendDataModel: true,
        },
      },
      components("1.0", v1Components, second),
      data("1.0", updatedData, second),
    ];
    const newData = { title: "SECOND", items: [{ name: "Eta" }] };
    const output = await run(
      wrap([
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "call-1",
          toolCallName: "generate_a2ui",
        },
        { type: EventType.TOOL_CALL_END, toolCallId: "call-1" },
        {
          ...activity("call-1", { a2ui_operations: completeV1 }),
          messageId: `a2ui-surface-${SURFACE}-call-1`,
        },
        {
          ...activity("call-1", { a2ui_operations: completeSecond }),
          messageId: `a2ui-surface-${second}-call-1`,
        },
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: "result-1",
          toolCallId: "call-1",
          content: JSON.stringify({
            a2ui_operations: [
              ...updateOnlyV1,
              components("1.0", v1Components, second),
              data("1.0", newData, second),
            ],
          }),
        },
      ] as BaseEvent[]),
    );
    const after = paintsAfterResult(output, "call-1");
    expect(after.map((e) => e.messageId)).toEqual([
      `a2ui-surface-${second}-call-1`,
    ]);
    expect(opsOf(after[0])).toEqual([
      completeSecond[0],
      components("1.0", v1Components, second),
      data("1.0", newData, second),
    ]);
    expect(
      opsOf(lastSnapshot(output, `a2ui-surface-${SURFACE}-call-1`)),
    ).toEqual(completeV1);
    const ids = new Set(output.filter(isPaint).map((e) => e.messageId));
    expect(ids.size).toBe(2);
    expectSelfContained(output);
  });
});
