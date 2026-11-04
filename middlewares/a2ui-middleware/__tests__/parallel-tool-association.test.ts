import { describe, expect, it } from "vitest";
import { ActivitySnapshotEvent, BaseEvent, EventType } from "@ag-ui/client";
import { A2UIMiddleware, A2UIMiddlewareConfig } from "../src";
import { MockAgent, collectEvents, createRunAgentInput } from "./test-utils";
import langgraphImport from "./fixtures/langgraph-import.json";
import langgraphLive from "./fixtures/langgraph-live.json";
import strandsImport from "./fixtures/strands-ts-import.json";
import strandsLive from "./fixtures/strands-ts-live.json";
import nestedRecovery from "./fixtures/langgraph-nested-recovery.json";

async function paint(events: BaseEvent[], config: A2UIMiddlewareConfig = {}) {
  const output = await collectEvents(
    new A2UIMiddleware({
      defaultCatalogId: "copilotkit://app-dashboard-catalog",
      ...config,
    }).run(createRunAgentInput(), new MockAgent(events)),
  );
  return output.filter(
    (event): event is ActivitySnapshotEvent =>
      event.type === EventType.ACTIVITY_SNAPSHOT,
  );
}

describe("parallel A2UI tool association", () => {
  it.each([
    ["LangGraph native import", langgraphImport],
    ["LangGraph live stream", langgraphLive],
    ["Strands TypeScript native import", strandsImport],
    ["Strands TypeScript live stream with explicit wrapper names", strandsLive],
  ])(
    "keeps sibling flight and dashboard surfaces separate: %s",
    async (_name, events) => {
      const flight = events.find(
        (event) =>
          "toolCallName" in event && event.toolCallName === "search_flights",
      );
      const dashboard = events.find(
        (event) =>
          "toolCallName" in event && event.toolCallName === "render_a2ui",
      );
      if (
        !flight ||
        !dashboard ||
        !("toolCallId" in flight) ||
        !("toolCallId" in dashboard)
      )
        throw new Error("Missing native tool calls");
      const typedEvents = events.map((event) => {
        const type = Object.values(EventType).find(
          (type) => type === event.type,
        );
        if (!type)
          throw new Error(`Unknown recorded event type: ${event.type}`);
        return { ...event, type };
      });
      const snapshots = await paint(
        typedEvents,
        events === strandsLive ? { a2uiGenerationToolNames: [] } : {},
      );
      const dashboardPaint = snapshots.filter((event) =>
        JSON.stringify(event.content).includes('"canary-dashboard"'),
      );
      const flightPaint = snapshots.filter((event) =>
        JSON.stringify(event.content).includes('"flight-search-results"'),
      );
      expect(dashboardPaint.length).toBeGreaterThan(0);
      expect(
        dashboardPaint.every(
          (event) => event.messageId === `a2ui-surface-${dashboard.toolCallId}`,
        ),
      ).toBe(true);
      expect(flightPaint.length).toBeGreaterThan(0);
      if (events === strandsLive) {
        const content = JSON.stringify(
          flightPaint.map((event) => event.content),
        );
        expect(content).toContain("DL123");
        expect(content).toContain("AA456");
      }
      expect(
        flightPaint.every((event) =>
          event.messageId.endsWith(`-${flight.toolCallId}`),
        ),
      ).toBe(true);
      expect(
        snapshots
          .filter((event) => event.content.status)
          .every(
            (event) =>
              event.messageId === `a2ui-surface-${dashboard.toolCallId}`,
          ),
      ).toBe(true);
    },
  );

  it("preserves legacy nested renders after the outer arguments end", async () => {
    const snapshots = await paint([
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "outer",
        toolCallName: "generate_a2ui",
        parentMessageId: "outer-message",
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "outer" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "inner",
        toolCallName: "render_a2ui",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "inner",
        delta: JSON.stringify({
          surfaceId: "nested",
          components: [{ id: "root", component: "Text", text: "Nested" }],
        }),
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "inner" },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "outer",
        messageId: "outer-result",
        content: JSON.stringify({
          a2ui_operations: [
            {
              version: "v0.9",
              createSurface: {
                surfaceId: "nested",
                catalogId: "copilotkit://app-dashboard-catalog",
              },
            },
          ],
        }),
      },
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" },
    ]);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(
      snapshots.every((event) => event.messageId === "a2ui-surface-outer"),
    ).toBe(true);
    expect(
      snapshots.filter((event) => event.content.a2ui_operations),
    ).toHaveLength(1);
  });

  it.each(
    Object.entries(nestedRecovery).flatMap(([name, events]) => [
      { name, events, custom: false, configured: false },
      { name, events, custom: true, configured: false },
      { name, events, custom: true, configured: true },
    ]),
  )(
    "preserves recorded nested recovery: $name (custom wrapper: $custom, configured: $configured)",
    async ({ name, events, custom, configured }) => {
      const typedEvents = events.map((event) => {
        const type = Object.values(EventType).find(
          (type) => type === event.type,
        );
        if (!type) throw new Error(`Unknown event type: ${event.type}`);
        return {
          ...event,
          type,
          ...("toolCallName" in event &&
          event.toolCallName === "generate_a2ui" &&
          custom
            ? { toolCallName: "custom_generate" }
            : {}),
        };
      });
      const snapshots = await paint(
        typedEvents,
        configured ? { a2uiGenerationToolNames: ["custom_generate"] } : {},
      );
      expect(snapshots.length).toBeGreaterThan(0);
      expect(new Set(snapshots.map((event) => event.messageId))).toEqual(
        new Set(["a2ui-surface-id-4"]),
      );
      expect(
        snapshots.some((event) => event.content.status === "retrying"),
      ).toBe(true);
      if (name.includes("Exhaustion")) {
        expect(snapshots.at(-1)?.content.status).toBe("failed");
        expect(
          snapshots.filter((event) => event.content.a2ui_operations),
        ).toHaveLength(0);
      } else {
        expect(snapshots.at(-1)?.content.a2ui_operations).toBeDefined();
      }
    },
  );

  it("keeps same-message siblings separate even for a generation wrapper", async () => {
    const events = strandsImport.map((event) => {
      const type = Object.values(EventType).find((type) => type === event.type);
      if (!type) throw new Error(`Unknown event type: ${event.type}`);
      return {
        ...event,
        type,
        ...("toolCallName" in event && event.toolCallName === "search_flights"
          ? { toolCallName: "generate_a2ui" }
          : {}),
      };
    });
    const render = events.find(
      (event) =>
        "toolCallName" in event && event.toolCallName === "render_a2ui",
    );
    if (!render || !("toolCallId" in render)) throw new Error("Missing render");
    const snapshots = await paint(events);
    const dashboard = snapshots.filter((event) =>
      JSON.stringify(event.content).includes('"canary-dashboard"'),
    );
    expect(dashboard.length).toBeGreaterThan(0);
    expect(
      dashboard.every(
        (event) => event.messageId === `a2ui-surface-${render.toolCallId}`,
      ),
    ).toBe(true);
  });

  it("attributes out-of-order results and failures to their own calls", async () => {
    const envelope = JSON.stringify({
      a2ui_operations: [
        {
          version: "v0.9",
          createSurface: {
            surfaceId: "flights",
            catalogId: "copilotkit://app-dashboard-catalog",
          },
        },
      ],
    });
    const snapshots = await paint([
      { type: EventType.RUN_STARTED, threadId: "test", runId: "test" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "flights",
        toolCallName: "search_flights",
        parentMessageId: "siblings",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "failed",
        toolCallName: "generate_a2ui",
        parentMessageId: "siblings",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "unrelated",
        toolCallName: "query_data",
        parentMessageId: "siblings",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "flights",
        messageId: "result-flights",
        role: "tool",
        content: envelope,
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "failed",
        messageId: "result-failed",
        role: "tool",
        content: JSON.stringify({
          code: "a2ui_recovery_exhausted",
          error: "invalid components",
          attempts: [1, 2],
        }),
      },
      { type: EventType.RUN_FINISHED, threadId: "test", runId: "test" },
    ]);
    expect(
      snapshots.find((event) => event.content.a2ui_operations)?.messageId,
    ).toBe("a2ui-surface-flights");
    expect(
      snapshots.find((event) => event.content.status === "failed")?.messageId,
    ).toBe("a2ui-surface-failed");
  });
});
