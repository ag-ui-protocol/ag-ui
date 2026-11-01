import { describe, expect, it } from "vitest";
import {
  AbstractAgent,
  ActivitySnapshotEvent,
  BaseEvent,
  EventType,
  RunAgentInput,
  ToolCallResultEvent,
} from "@ag-ui/client";
import { from } from "rxjs";
import { A2UIMiddleware } from "../src/index";
import { collectEvents, createRunAgentInput, MockAgent } from "./test-utils";

const malformed = JSON.stringify({
  surfaceId: "sales",
  components: [{ id: "root", type: "text", props: { text: "Sales" } }],
  data: {},
});
const valid = JSON.stringify({
  surfaceId: "valid",
  components: [{ id: "root", component: "Text", text: "Hello" }],
  data: {},
});
const start: BaseEvent = {
  type: EventType.RUN_STARTED,
  runId: "r",
  threadId: "t",
};
const finish: BaseEvent = {
  type: EventType.RUN_FINISHED,
  runId: "r",
  threadId: "t",
};
function render(args: string, toolCallId = "render"): BaseEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: "render_a2ui",
    },
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: args },
    { type: EventType.TOOL_CALL_END, toolCallId },
  ];
}
async function run(events: BaseEvent[]) {
  return collectEvents(
    new A2UIMiddleware().run(createRunAgentInput(), new MockAgent(events)),
  );
}
function snapshots(events: BaseEvent[]) {
  return events.filter(
    (e): e is ActivitySnapshotEvent => e.type === EventType.ACTIVITY_SNAPSHOT,
  );
}
function results(events: BaseEvent[]) {
  return events.filter(
    (e): e is ToolCallResultEvent => e.type === EventType.TOOL_CALL_RESULT,
  );
}
function expectFailed(events: BaseEvent[], key = "render") {
  const activity = snapshots(events)
    .filter((e) => e.messageId === `a2ui-surface-${key}`)
    .at(-1);
  expect(activity?.content).toMatchObject({
    status: "failed",
    error: expect.any(String),
  });
  expect(activity?.replace).toBe(true);
  expect(events.indexOf(activity!)).toBeLessThan(
    events.findIndex((e) => e.type === EventType.RUN_FINISHED),
  );
}

describe("malformed A2UI terminal lifecycle", () => {
  it("validates type/props components and returns actionable failure", async () => {
    const events = await run([start, ...render(malformed), finish]);
    expectFailed(events);
    expect(snapshots(events).some((e) => e.content.a2ui_operations)).toBe(
      false,
    );
    expect(results(events)).toHaveLength(1);
    expect(JSON.parse(String(results(events)[0].content))).toMatchObject({
      status: "failed",
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "missing_component_type" }),
      ]),
    });
  });

  it("clears loading even when an upstream result already closed the call", async () => {
    const events = await run([
      start,
      ...render(malformed),
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "render",
        messageId: "result",
        content: '{"status":"failed"}',
      },
      finish,
    ]);
    expectFailed(events);
    expect(results(events)).toHaveLength(1);
  });

  it.each([
    "{}",
    '{"surfaceId":"sales","components":[]}',
    '{"surfaceId":"sales","components":',
    '{"components":[{"id":"root","component":"Text"}]}',
  ])("terminates incomplete or empty payload %s", async (args) => {
    expectFailed(await run([start, ...render(args), finish]));
  });

  it("settles a failed nested attempt on its outer activity", async () => {
    const events = await run([
      start,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "outer",
        toolCallName: "generate_a2ui",
      },
      ...render(malformed),
      finish,
    ]);
    expectFailed(events, "outer");
  });

  it("preserves a successful retry sharing the outer activity", async () => {
    const events = await run([
      start,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "outer",
        toolCallName: "generate_a2ui",
      },
      ...render(malformed),
      ...render(valid, "retry"),
      finish,
    ]);
    expect(snapshots(events).at(-1)?.content.a2ui_operations).toBeDefined();
    expect(
      snapshots(events).filter((e) => e.content.status === "failed"),
    ).toHaveLength(0);
    expect(
      results(events).map((e) => JSON.parse(String(e.content)).status),
    ).toEqual(["failed", "rendered"]);
  });

  it("preserves valid sibling surfaces when another call fails", async () => {
    const events = await run([
      start,
      ...render(valid, "good"),
      ...render(malformed),
      finish,
    ]);
    expectFailed(events);
    expect(
      snapshots(events)
        .filter((e) => e.messageId === "a2ui-surface-good")
        .at(-1)?.content.a2ui_operations,
    ).toBeDefined();
  });
  it("rejects a closed malformed array before the data tail finishes", async () => {
    const head =
      '{"surfaceId":"sales","components":[{"id":"root","type":"text","props":{"text":"Sales"}}]';
    const events = await run([
      start,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "render",
        toolCallName: "render_a2ui",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "render", delta: head },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "render",
        delta: ',"data":{}}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "render" },
      finish,
    ]);
    const retry = snapshots(events).find(
      (e) => e.content.status === "retrying",
    );
    expect(retry?.content.errors).toContainEqual(
      expect.objectContaining({ code: "missing_component_type" }),
    );
    expectFailed(events);
  });

  it("clears loading on completion without RUN_FINISHED", async () => {
    const events = await run([start, ...render(malformed)]);
    expect(snapshots(events).at(-1)?.content.status).toBe("failed");
    expect(results(events)).toHaveLength(0);
  });

  it("clears loading before forwarding RUN_ERROR", async () => {
    const events = await run([
      start,
      ...render(malformed),
      { type: EventType.RUN_ERROR, message: "Provider failed" },
    ]);
    const failed = snapshots(events).at(-1);
    expect(failed?.content.status).toBe("failed");
    expect(events.indexOf(failed!)).toBeLessThan(
      events.findIndex((e) => e.type === EventType.RUN_ERROR),
    );
    expect(results(events)).toHaveLength(0);
  });

  it("preserves an explicit result envelope that replaces malformed streamed arguments", async () => {
    const events = await run([
      start,
      ...render(malformed),
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "render",
        messageId: "result",
        content: JSON.stringify({
          a2ui_operations: [
            {
              version: "v0.9",
              createSurface: { surfaceId: "fixed", catalogId: "basic" },
            },
            {
              version: "v0.9",
              updateComponents: {
                surfaceId: "fixed",
                components: [
                  { id: "root", component: "Text", text: "Recovered" },
                ],
              },
            },
          ],
        }),
      },
      finish,
    ]);
    expect(snapshots(events).at(-1)?.content.a2ui_operations).toBeDefined();
    expect(
      snapshots(events).filter((e) => e.content.status === "failed"),
    ).toHaveLength(0);
    expect(results(events)).toHaveLength(1);
  });

  it("settles the last loading activity before the continuation cap errors", async () => {
    class RepeatingAgent extends AbstractAgent {
      calls = 0;
      run(input: RunAgentInput) {
        this.calls++;
        return from([
          {
            type: EventType.RUN_STARTED,
            runId: input.runId,
            threadId: input.threadId,
          },
          ...render(malformed, `render-${this.calls}`),
          {
            type: EventType.RUN_FINISHED,
            runId: input.runId,
            threadId: input.threadId,
          },
        ]);
      }
    }
    const events: BaseEvent[] = [];
    const agent = new RepeatingAgent();
    const error = await new Promise<Error>((resolve, reject) => {
      new A2UIMiddleware().run(createRunAgentInput(), agent).subscribe({
        next: (event) => events.push(event),
        error: resolve,
        complete: () => reject(new Error("Expected the continuation limit")),
      });
    });
    expect(error.message).toContain("continuation limit reached (10)");
    expect(agent.calls).toBe(11);
    expect(snapshots(events).at(-1)).toMatchObject({
      messageId: "a2ui-surface-render-11",
      content: { status: "failed" },
    });
  });
  it("replaces the loading slot and preserves every surface in a multi-surface fallback", async () => {
    const operations = ["first", "second"].flatMap((surfaceId) => [
      { version: "v0.9", createSurface: { surfaceId, catalogId: "basic" } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId,
          components: [{ id: "root", component: "Text", text: surfaceId }],
        },
      },
    ]);
    const events = await run([
      start,
      ...render(malformed),
      {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "render",
        messageId: "result",
        content: JSON.stringify({ a2ui_operations: operations }),
      },
      finish,
    ]);
    const latest = new Map(
      snapshots(events).map((e) => [e.messageId, e.content]),
    );
    expect(latest.get("a2ui-surface-render")?.a2ui_operations).toEqual(
      operations.slice(0, 2),
    );
    expect(latest.get("a2ui-surface-second-render")?.a2ui_operations).toEqual(
      operations.slice(2),
    );
    expect([...latest.values()].some((content) => content.status)).toBe(false);
  });
});
