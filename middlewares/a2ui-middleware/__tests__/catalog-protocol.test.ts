import { describe, expect, it } from "vitest";
import {
  ActivitySnapshotEvent,
  BaseEvent,
  EventType,
  ToolCallResultEvent,
} from "@ag-ui/client";
import {
  A2UIMiddleware,
  A2UIMiddlewareConfig,
  A2UI_SCHEMA_CONTEXT_DESCRIPTION,
} from "../src";
import { MockAgent, collectEvents, createRunAgentInput } from "./test-utils";
import v1Catalog from "./fixtures/a2ui-1.0-basic-catalog.json";

/**
 * Direct JSON generation (the ADK `generate_a2ui` wrapper streaming a nested
 * `render_a2ui` call, then returning the canonical envelope as its result).
 *
 * The middleware paints the nested call progressively and must label those
 * paints with the protocol the catalog declares. The wrapper's final envelope is
 * then either redundant (identical to the paint) or authoritative (different),
 * never dropped because the surface "was already streamed".
 */

const V1_CATALOG_ID =
  "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
const V0_9_CATALOG_ID =
  "https://a2ui.org/specification/v0_9/basic_catalog.json";

const v09Catalog = {
  catalogId: V0_9_CATALOG_ID,
  components: {
    Column: { type: "object", required: ["id", "component"] },
    Text: { type: "object", required: ["id", "component", "text"] },
    List: { type: "object", required: ["id", "component", "children"] },
  },
};

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

const createData = {
  title: "CPK187_CREATE",
  items: [{ name: "Alpha" }, { name: "Beta" }],
};
const updatedData = {
  title: "CPK187_UPDATED",
  items: [{ name: "Gamma" }, { name: "Delta" }],
};

const SURFACE = "validation-surface";

function schemaContext(catalog: Record<string, unknown>) {
  return {
    description: A2UI_SCHEMA_CONTEXT_DESCRIPTION,
    value: JSON.stringify(catalog),
  };
}

function envelope(
  version: string,
  catalogId: string,
  components: unknown,
  data: unknown,
  { create = true }: { create?: boolean } = {},
) {
  return JSON.stringify({
    a2ui_operations: [
      ...(create
        ? [{ version, createSurface: { surfaceId: SURFACE, catalogId } }]
        : []),
      { version, updateComponents: { surfaceId: SURFACE, components } },
      {
        version,
        updateDataModel: { surfaceId: SURFACE, path: "/", value: data },
      },
    ],
  });
}

/** The ADK Direct JSON contract: one wrapper call, one nested streamed render, one result. */
function directJsonRun(options: {
  wrapperCallId: string;
  renderCallId: string;
  args: Record<string, unknown>;
  result: string;
  intent?: Record<string, unknown>;
}): BaseEvent[] {
  return [
    { type: EventType.RUN_STARTED, runId: "run", threadId: "thread" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: options.wrapperCallId,
      toolCallName: "generate_a2ui",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: options.wrapperCallId,
      delta: JSON.stringify(options.intent ?? { intent: "create" }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: options.wrapperCallId },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: options.renderCallId,
      toolCallName: "render_a2ui",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: options.renderCallId,
      delta: JSON.stringify(options.args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: options.renderCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "result-message",
      toolCallId: options.wrapperCallId,
      content: options.result,
    },
    { type: EventType.RUN_FINISHED, runId: "run", threadId: "thread" },
  ] as BaseEvent[];
}

async function run(
  events: BaseEvent[],
  catalog: Record<string, unknown>,
  config: A2UIMiddlewareConfig = {},
) {
  const middleware = new A2UIMiddleware(config);
  const output = await collectEvents(
    middleware.run(
      createRunAgentInput({ context: [schemaContext(catalog)] }),
      new MockAgent(events),
    ),
  );
  return output;
}

const isPaint = (event: BaseEvent): event is ActivitySnapshotEvent =>
  event.type === EventType.ACTIVITY_SNAPSHOT &&
  Array.isArray((event as ActivitySnapshotEvent).content?.a2ui_operations);

const opsOf = (event: ActivitySnapshotEvent) =>
  event.content.a2ui_operations as Array<Record<string, unknown>>;

function paintsAfterResult(output: BaseEvent[], toolCallId: string) {
  const index = output.findIndex(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT &&
      (event as ToolCallResultEvent).toolCallId === toolCallId,
  );
  expect(index).toBeGreaterThan(-1);
  return output.slice(index + 1).filter(isPaint);
}

function lastPaint(output: BaseEvent[], messageId: string) {
  const paints = output
    .filter(isPaint)
    .filter((event) => event.messageId === messageId);
  expect(paints.length).toBeGreaterThan(0);
  return paints[paints.length - 1];
}

describe("catalog-driven protocol selection for streamed Direct JSON paints", () => {
  it("labels streamed paints with the catalog's native 1.0 protocol", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: createData,
        },
        result: envelope("1.0", V1_CATALOG_ID, v1Components, createData),
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );

    const paints = output.filter(isPaint);
    expect(paints.length).toBeGreaterThan(0);
    for (const paint of paints) {
      expect(paint.messageId).toBe("a2ui-surface-call-generate");
      for (const op of opsOf(paint)) {
        expect(op.version).toBe("1.0");
      }
    }
    const final = lastPaint(output, "a2ui-surface-call-generate");
    const create = opsOf(final).find((op) => op.createSurface) as any;
    expect(create.createSurface).toEqual({
      surfaceId: SURFACE,
      catalogId: V1_CATALOG_ID,
    });
    const components = opsOf(final).find((op) => op.updateComponents) as any;
    // Native 1.0 bindings pass through untouched — no relabeling of shapes.
    expect(components.updateComponents.components).toEqual(v1Components);
    const data = opsOf(final).find((op) => op.updateDataModel) as any;
    expect(data.updateDataModel).toEqual({
      surfaceId: SURFACE,
      path: "/",
      value: createData,
    });
  });

  it("keeps streamed paints on v0.9 for a catalog without a protocol declaration", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v09Components,
          data: createData,
        },
        result: envelope("v0.9", V0_9_CATALOG_ID, v09Components, createData),
      }),
      v09Catalog,
      { defaultCatalogId: V0_9_CATALOG_ID },
    );

    const paints = output.filter(isPaint);
    expect(paints.length).toBeGreaterThan(0);
    for (const paint of paints) {
      for (const op of opsOf(paint)) {
        expect(op.version).toBe("v0.9");
      }
    }
    const create = opsOf(paints[0]).find((op) => op.createSurface) as any;
    expect(create.createSurface.catalogId).toBe(V0_9_CATALOG_ID);
  });

  it("honors an explicit 0.9 protocol declaration", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v09Components,
          data: createData,
        },
        result: envelope("v0.9", V0_9_CATALOG_ID, v09Components, createData),
      }),
      { ...v09Catalog, protocolVersion: "0.9" },
      { defaultCatalogId: V0_9_CATALOG_ID },
    );
    for (const paint of output.filter(isPaint)) {
      for (const op of opsOf(paint)) expect(op.version).toBe("v0.9");
    }
  });

  it("reads the protocol from a configured inline catalog before the frontend entry", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: createData,
        },
        result: envelope("1.0", V1_CATALOG_ID, v1Components, createData),
      }),
      v09Catalog,
      { defaultCatalogId: V1_CATALOG_ID, schema: v1Catalog as any },
    );
    const paints = output.filter(isPaint);
    expect(paints.length).toBeGreaterThan(0);
    for (const paint of paints) {
      for (const op of opsOf(paint)) expect(op.version).toBe("1.0");
    }
  });
});

describe("final envelope handling after a streamed Direct JSON paint", () => {
  it("suppresses a final 1.0 envelope that repeats the streamed paint, keeping one complete activity", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: createData,
        },
        result: envelope("1.0", V1_CATALOG_ID, v1Components, createData),
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );

    expect(paintsAfterResult(output, "call-generate")).toHaveLength(0);
    const anchors = new Set(output.filter(isPaint).map((e) => e.messageId));
    expect([...anchors]).toEqual(["a2ui-surface-call-generate"]);
    // The activity that stands is byte-equivalent to the canonical envelope.
    expect(opsOf(lastPaint(output, "a2ui-surface-call-generate"))).toEqual(
      JSON.parse(envelope("1.0", V1_CATALOG_ID, v1Components, createData))
        .a2ui_operations,
    );
  });

  it("applies a final envelope that differs from the streamed paint onto the same activity", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: createData,
        },
        // The wrapper settled on different data than the attempt streamed.
        result: envelope("1.0", V1_CATALOG_ID, v1Components, updatedData),
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );

    const after = paintsAfterResult(output, "call-generate");
    expect(after).toHaveLength(1);
    expect(after[0].messageId).toBe("a2ui-surface-call-generate");
    expect(opsOf(after[0])).toEqual(
      JSON.parse(envelope("1.0", V1_CATALOG_ID, v1Components, updatedData))
        .a2ui_operations,
    );
    const anchors = new Set(output.filter(isPaint).map((e) => e.messageId));
    expect(anchors.size).toBe(1);
  });

  it("merges an update-only final envelope onto the streamed creation so the activity stays replayable", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-2",
        intent: {
          intent: "update",
          target_surface_id: SURFACE,
          changes: "new title and items",
        },
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: updatedData,
        },
        result: envelope("1.0", V1_CATALOG_ID, v1Components, updatedData, {
          create: false,
        }),
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );

    const final = lastPaint(output, "a2ui-surface-call-generate");
    const ops = opsOf(final);
    expect(ops[0]).toEqual({
      version: "1.0",
      createSurface: { surfaceId: SURFACE, catalogId: V1_CATALOG_ID },
    });
    expect(ops.slice(1)).toEqual(
      JSON.parse(
        envelope("1.0", V1_CATALOG_ID, v1Components, updatedData, {
          create: false,
        }),
      ).a2ui_operations,
    );
    // Nothing was emitted without a creation.
    for (const paint of output.filter(isPaint)) {
      expect(opsOf(paint)[0].createSurface).toBeDefined();
    }
  });

  it("merges a differing update-only final envelope (0.9) onto the streamed creation", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-2",
        intent: { intent: "update", target_surface_id: SURFACE, changes: "x" },
        args: {
          surfaceId: SURFACE,
          components: v09Components,
          data: createData,
        },
        result: envelope("v0.9", V0_9_CATALOG_ID, v09Components, updatedData, {
          create: false,
        }),
      }),
      v09Catalog,
      { defaultCatalogId: V0_9_CATALOG_ID },
    );

    const after = paintsAfterResult(output, "call-generate");
    expect(after).toHaveLength(1);
    const ops = opsOf(after[0]);
    expect(ops[0]).toEqual({
      version: "v0.9",
      createSurface: { surfaceId: SURFACE, catalogId: V0_9_CATALOG_ID },
    });
    expect((ops[2] as any).updateDataModel.value).toEqual(updatedData);
  });

  it("forwards the canonical TOOL_CALL_RESULT unchanged", async () => {
    const result = envelope("1.0", V1_CATALOG_ID, v1Components, updatedData, {
      create: false,
    });
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-2",
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: updatedData,
        },
        result,
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );
    const forwarded = output.find(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT &&
        (event as ToolCallResultEvent).toolCallId === "call-generate",
    ) as ToolCallResultEvent;
    expect(forwarded.content).toBe(result);
    expect(forwarded.messageId).toBe("result-message");
  });

  it("still paints a final envelope for a surface the streamed attempt never painted", async () => {
    // The nested attempt failed structural validation (no root), so nothing
    // streamed; the wrapper's (retried, valid) envelope must paint as-is.
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: [{ id: "orphan", component: "Text", text: "x" }],
          data: {},
        },
        result: envelope("1.0", V1_CATALOG_ID, v1Components, createData),
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );
    const after = paintsAfterResult(output, "call-generate");
    expect(after).toHaveLength(1);
    expect(after[0].messageId).toBe("a2ui-surface-call-generate");
    expect(opsOf(after[0])).toEqual(
      JSON.parse(envelope("1.0", V1_CATALOG_ID, v1Components, createData))
        .a2ui_operations,
    );
  });
});

describe("payload shape must match the declared protocol", () => {
  const retryingFor = (output: BaseEvent[], messageId: string) =>
    output.filter(
      (event) =>
        event.type === EventType.ACTIVITY_SNAPSHOT &&
        (event as ActivitySnapshotEvent).messageId === messageId &&
        (event as ActivitySnapshotEvent).content.status === "retrying",
    ) as ActivitySnapshotEvent[];

  it("does not relabel 0.9 bindings as 1.0 under a 1.0 catalog", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        // `{ path }` value bindings are the 0.9 form; a 1.0 catalog needs `@path`.
        args: {
          surfaceId: SURFACE,
          components: v09Components,
          data: createData,
        },
        result: envelope("1.0", V1_CATALOG_ID, v1Components, createData),
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );

    // No streamed paint carried the mismatched payload under either label.
    const resultIndex = output.findIndex(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(output.slice(0, resultIndex).filter(isPaint)).toHaveLength(0);
    const retrying = retryingFor(output, "a2ui-surface-call-generate");
    expect(retrying.length).toBeGreaterThan(0);
    const errors = retrying[0].content.errors as Array<{ code: string }>;
    expect(errors.some((e) => e.code === "protocol_mismatch")).toBe(true);
    // The adapter's valid final envelope still paints.
    const after = paintsAfterResult(output, "call-generate");
    expect(after).toHaveLength(1);
    expect(opsOf(after[0]).every((op) => op.version === "1.0")).toBe(true);
  });

  it("does not relabel 1.0 bindings as v0.9 under a 0.9 catalog", async () => {
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: createData,
        },
        result: envelope("v0.9", V0_9_CATALOG_ID, v09Components, createData),
      }),
      v09Catalog,
      { defaultCatalogId: V0_9_CATALOG_ID },
    );
    const resultIndex = output.findIndex(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(output.slice(0, resultIndex).filter(isPaint)).toHaveLength(0);
    const retrying = retryingFor(output, "a2ui-surface-call-generate");
    expect(retrying.length).toBeGreaterThan(0);
    const errors = retrying[0].content.errors as Array<{ code: string }>;
    expect(errors.some((e) => e.code === "protocol_mismatch")).toBe(true);
  });

  it("accepts protocol-neutral components under either catalog", async () => {
    const neutral = [
      { id: "root", component: "Column", children: ["heading"] },
      { id: "heading", component: "Text", text: "Static" },
    ];
    for (const [catalog, catalogId, version] of [
      [v1Catalog, V1_CATALOG_ID, "1.0"],
      [v09Catalog, V0_9_CATALOG_ID, "v0.9"],
    ] as const) {
      const output = await run(
        directJsonRun({
          wrapperCallId: "call-generate",
          renderCallId: "a2ui-render-1",
          args: { surfaceId: SURFACE, components: neutral, data: {} },
          result: envelope(version, catalogId, neutral, {}),
        }),
        catalog as Record<string, unknown>,
        { defaultCatalogId: catalogId },
      );
      const paints = output.filter(isPaint);
      expect(paints.length).toBeGreaterThan(0);
      for (const paint of paints) {
        for (const op of opsOf(paint)) expect(op.version).toBe(version);
      }
    }
  });
});

describe("zero-config catalog fallback", () => {
  it("falls back to the 1.0 basic catalog when a 1.0 catalog declares no id", async () => {
    const middleware = new A2UIMiddleware();
    const { catalogId: _ignored, ...withoutId } = v1Catalog as Record<
      string,
      unknown
    >;
    const output = await collectEvents(
      middleware.run(
        createRunAgentInput({ context: [schemaContext(withoutId)] }),
        new MockAgent(
          directJsonRun({
            wrapperCallId: "call-generate",
            renderCallId: "a2ui-render-1",
            args: {
              surfaceId: SURFACE,
              components: v1Components,
              data: createData,
            },
            result: envelope("1.0", V1_CATALOG_ID, v1Components, createData),
          }),
        ),
      ),
    );
    const paints = output.filter(isPaint);
    expect(paints.length).toBeGreaterThan(0);
    const create = opsOf(paints[0]).find((op) => op.createSurface) as any;
    expect(create.version).toBe("1.0");
    expect(create.createSurface.catalogId).toBe(V1_CATALOG_ID);
  });
});

describe("review follow-ups: protocol handling", () => {
  it("normalizes declared versions the way the adapter's semver reading does", async () => {
    const { normalizeProtocolVersion } = await import("../src");
    expect(normalizeProtocolVersion("1.0")).toBe("1.0");
    expect(normalizeProtocolVersion("v1.0")).toBe("1.0");
    expect(normalizeProtocolVersion("1.0.0")).toBe("1.0");
    expect(normalizeProtocolVersion("0.9")).toBe("v0.9");
    expect(normalizeProtocolVersion("v0.9.1")).toBe("v0.9");
    expect(normalizeProtocolVersion("1")).toBeUndefined();
    expect(normalizeProtocolVersion("2.0")).toBeUndefined();
    expect(normalizeProtocolVersion(1)).toBeUndefined();
  });

  it("accepts a literal object with a path field when the payload binds with @path", async () => {
    const withLiteral = [
      {
        id: "heading",
        component: "Text",
        text: { "@path": "/title" },
        link: { label: "Docs", path: "/docs" },
      },
      { id: "root", component: "Column", children: ["heading"] },
    ];
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: withLiteral,
          data: { title: "T" },
        },
        result: envelope("1.0", V1_CATALOG_ID, withLiteral, { title: "T" }),
      }),
      v1Catalog,
      { defaultCatalogId: V1_CATALOG_ID },
    );
    const resultIndex = output.findIndex(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    const streamed = output.slice(0, resultIndex).filter(isPaint);
    expect(streamed.length).toBeGreaterThan(0);
    expect(opsOf(streamed[0]).every((op) => op.version === "1.0")).toBe(true);
  });

  it("keeps the middleware-resolved catalog when the final envelope names another", async () => {
    // Catalog ownership stays with the host: the streamed creation resolves to
    // the frontend-registered catalog; an adapter default of "basic" in the
    // final envelope must not replace it.
    const output = await run(
      directJsonRun({
        wrapperCallId: "call-generate",
        renderCallId: "a2ui-render-1",
        args: {
          surfaceId: SURFACE,
          components: v1Components,
          data: createData,
        },
        result: envelope("1.0", "basic", v1Components, createData),
      }),
      v1Catalog,
    );
    expect(paintsAfterResult(output, "call-generate")).toHaveLength(0);
    const create = opsOf(lastPaint(output, "a2ui-surface-call-generate")).find(
      (op) => op.createSurface,
    ) as any;
    expect(create.createSurface.catalogId).toBe(V1_CATALOG_ID);
  });

  it("paints a later call's valid envelope on that call's own slot with the known creation", async () => {
    // call-1 streamed the surface. call-2's nested attempt is rejected (no
    // root) so its slot shows "retrying"; call-2's final envelope is a valid
    // update. It must resolve call-2's own slot — replayable, with the creation
    // the run already knows — instead of folding into call-1 and leaving the
    // skeleton behind.
    const first = directJsonRun({
      wrapperCallId: "call-1",
      renderCallId: "a2ui-render-1",
      args: { surfaceId: SURFACE, components: v1Components, data: createData },
      result: envelope("1.0", V1_CATALOG_ID, v1Components, createData),
    });
    const second = directJsonRun({
      wrapperCallId: "call-2",
      renderCallId: "a2ui-render-2",
      intent: { intent: "update", target_surface_id: SURFACE, changes: "x" },
      args: {
        surfaceId: SURFACE,
        components: [{ id: "orphan", component: "Text", text: "x" }],
        data: {},
      },
      result: envelope("1.0", V1_CATALOG_ID, v1Components, updatedData, {
        create: false,
      }),
    });
    const events = [
      first[0],
      ...first.slice(1, -1),
      ...second.slice(1, -1),
      first[first.length - 1],
    ];
    const output = await run(events, v1Catalog, {
      defaultCatalogId: V1_CATALOG_ID,
    });

    const after = paintsAfterResult(output, "call-2");
    expect(after).toHaveLength(1);
    expect(after[0].messageId).toBe("a2ui-surface-call-2");
    expect(opsOf(after[0])).toEqual([
      {
        version: "1.0",
        createSurface: { surfaceId: SURFACE, catalogId: V1_CATALOG_ID },
      },
      ...JSON.parse(
        envelope("1.0", V1_CATALOG_ID, v1Components, updatedData, {
          create: false,
        }),
      ).a2ui_operations,
    ]);
    // call-1's activity is untouched and call-2's last state is the paint.
    expect(opsOf(lastPaint(output, "a2ui-surface-call-1"))).toEqual(
      JSON.parse(envelope("1.0", V1_CATALOG_ID, v1Components, createData))
        .a2ui_operations,
    );
    const call2 = output.filter(
      (event) =>
        event.type === EventType.ACTIVITY_SNAPSHOT &&
        (event as ActivitySnapshotEvent).messageId === "a2ui-surface-call-2",
    ) as ActivitySnapshotEvent[];
    expect(call2[call2.length - 1].content.status).toBeUndefined();
  });
});

describe("review follow-ups: injected tool guidance follows the catalog protocol", () => {
  const directRender = (components: unknown, data: unknown): BaseEvent[] =>
    [
      { type: EventType.RUN_STARTED, runId: "run", threadId: "thread" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc-direct",
        toolCallName: "render_a2ui",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tc-direct",
        delta: JSON.stringify({ surfaceId: SURFACE, components, data }),
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "tc-direct" },
      { type: EventType.RUN_FINISHED, runId: "run", threadId: "thread" },
    ] as BaseEvent[];

  it("instructs @path bindings and streams a 1.0 paint under a 1.0 catalog", async () => {
    const agent = new MockAgent(directRender(v1Components, createData));
    const output = await collectEvents(
      new A2UIMiddleware({ injectA2UITool: true }).run(
        createRunAgentInput({ context: [schemaContext(v1Catalog)] }),
        agent,
      ),
    );
    const input = agent.runCalls[0];
    const guide = input.context.find((c) =>
      c.description.startsWith("A2UI render tool usage guide"),
    );
    expect(guide).toBeDefined();
    expect(guide!.value).toContain('"@path"');
    expect(guide!.value).not.toContain('{ "path": "/key" }');
    expect(guide!.value).toContain("1.0");
    const tool = input.tools.find((t) => t.name === "render_a2ui");
    expect(tool!.description).toContain("1.0");
    expect(tool!.description).not.toContain("v0.9");

    const paints = output.filter(isPaint);
    expect(paints.length).toBeGreaterThan(0);
    for (const paint of paints) {
      expect(paint.messageId).toBe("a2ui-surface-tc-direct");
      for (const op of opsOf(paint)) expect(op.version).toBe("1.0");
    }
  });

  it("keeps the v0.9 guidance for a catalog without a declaration", async () => {
    const agent = new MockAgent(directRender(v09Components, createData));
    await collectEvents(
      new A2UIMiddleware({ injectA2UITool: true }).run(
        createRunAgentInput({ context: [schemaContext(v09Catalog)] }),
        agent,
      ),
    );
    const input = agent.runCalls[0];
    const guide = input.context.find((c) =>
      c.description.startsWith("A2UI render tool usage guide"),
    );
    expect(guide!.value).toContain('{ "path": "/key" }');
    expect(guide!.value).not.toContain('"@path"');
    const tool = input.tools.find((t) => t.name === "render_a2ui");
    expect(tool!.description).toContain("v0.9");
  });
});
