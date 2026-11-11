import { describe, expect, it } from "vitest";
import {
  EventType,
  type ActivitySnapshotEvent,
  type BaseEvent,
} from "@ag-ui/client";
import { A2UIMiddleware } from "../src";
import { MockAgent, collectEvents, createRunAgentInput } from "./test-utils";

const operations = [
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "existing",
      components: [{ id: "root", component: "Text", text: "Updated" }],
    },
  },
  {
    version: "v0.9",
    updateDataModel: { surfaceId: "existing", path: "/", value: { count: 2 } },
  },
];

async function stream(
  intent: string,
  explicitParent = true,
  target = "existing",
) {
  const result = {
    type: EventType.TOOL_CALL_RESULT,
    messageId: "result",
    toolCallId: "generator",
    content: JSON.stringify({ a2ui_operations: operations }),
  };
  const events: BaseEvent[] = [
    { type: EventType.RUN_STARTED, threadId: "thread", runId: "run" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "generator",
      toolCallName: "generate_a2ui",
      parentMessageId: "outer",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "generator",
      delta: JSON.stringify({ intent, target_surface_id: target }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: "generator" },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "render",
      toolCallName: "render_a2ui",
      parentMessageId: "inner",
      ...(explicitParent
        ? { metadata: { parentToolCallId: "generator" } }
        : {}),
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "render",
      delta: JSON.stringify({
        surfaceId: "existing",
        components: operations[0].updateComponents?.components,
        data: { count: 2 },
      }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: "render" },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "render-result",
      toolCallId: "render",
      content: '{"status":"rendered"}',
    },
    result,
    { type: EventType.RUN_FINISHED, threadId: "thread", runId: "run" },
  ];
  const output = await collectEvents(
    new A2UIMiddleware().run(createRunAgentInput(), new MockAgent(events)),
  );
  expect(
    output.find(
      (event) =>
        event.type === EventType.TOOL_CALL_RESULT &&
        event.toolCallId === "generator",
    ),
  ).toEqual(result);
  return output
    .filter(
      (event): event is ActivitySnapshotEvent =>
        event.type === EventType.ACTIVITY_SNAPSHOT,
    )
    .flatMap((event) => event.content.a2ui_operations ?? []);
}

describe("explicit existing-surface update intent", () => {
  it("never synthesizes createSurface for a declared parent update", async () => {
    const painted = await stream("update");
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.some((op) => op.createSurface)).toBe(false);
    expect(painted).toContainEqual(operations[1]);
  });
  it("retains creation for create intent", async () => {
    expect((await stream("create")).some((op) => op.createSurface)).toBe(true);
  });
  it("does not infer update intent from temporal proximity", async () => {
    expect((await stream("update", false)).some((op) => op.createSurface)).toBe(
      true,
    );
  });
  it("does not apply update intent to a different target", async () => {
    expect(
      (await stream("update", true, "other")).some((op) => op.createSurface),
    ).toBe(true);
  });
});
