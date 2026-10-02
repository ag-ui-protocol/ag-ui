import { describe, it, expect } from "vitest";
import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type Message,
} from "@ag-ui/client";
import { from, firstValueFrom, toArray } from "rxjs";
import { A2UIMiddleware, A2UI_SCHEMA_CONTEXT_DESCRIPTION } from "../src/index";
import history from "./fixtures/pni-568-orphan.json";

const orphan = history
  .flatMap((message) => message.tool_calls ?? [])
  .find((call) => call.id === "call_25dQx1aDND8JEi4wmPYlEQ6z")!;
const messages: Message[] = [
  {
    id: "saved-assistant",
    role: "assistant",
    toolCalls: [
      {
        id: orphan.id,
        type: "function",
        function: { name: orphan.name, arguments: JSON.stringify(orphan.args) },
      },
    ],
  },
  {
    id: "saved-followup",
    role: "user",
    content:
      "Native source provenance check: reply Cedar ready. Do not call any tools or modify todos.",
  },
];
class CaptureAgent extends AbstractAgent {
  input?: RunAgentInput;
  constructor(private events: BaseEvent[] = []) {
    super();
  }
  run(input: RunAgentInput) {
    this.input = input;
    return from([
      {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      },
      ...this.events,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      },
    ] as BaseEvent[]);
  }
}
const input = (messages: Message[]): RunAgentInput => ({
  threadId: "native-thread",
  runId: "r",
  messages,
  state: {},
  context: [],
  tools: [],
  forwardedProps: {},
});
const collect = (
  middleware: A2UIMiddleware,
  request: RunAgentInput,
  agent: CaptureAgent,
) => firstValueFrom(middleware.run(request, agent).pipe(toArray()));

describe("PNI-568 unanswered render recovery", () => {
  it("closes the historical orphan truthfully before the saved follow-up and only once after reload", async () => {
    const agent = new CaptureAgent();
    const middleware = new A2UIMiddleware();
    const events = await collect(middleware, input(messages), agent);
    expect(agent.input!.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "user",
    ]);
    expect(agent.input!.messages[0]).toEqual(messages[0]);
    expect(agent.input!.messages[2]).toEqual(messages[1]);
    const result = agent.input!.messages[1];
    expect(result).toMatchObject({ role: "tool", toolCallId: orphan.id });
    expect(JSON.parse(result.content as string)).toMatchObject({
      status: "cancelled",
      code: "a2ui_unanswered_call",
    });
    expect(
      events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: EventType.ACTIVITY_SNAPSHOT,
        content: expect.objectContaining({ status: "failed" }),
      }),
    );
    const reopened = new CaptureAgent();
    const replay = await collect(
      middleware,
      input(JSON.parse(JSON.stringify(agent.input!.messages))),
      reopened,
    );
    expect(reopened.input!.messages).toEqual(agent.input!.messages);
    expect(
      replay.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toHaveLength(0);
  });

  it("leaves pending approvals and completed results unchanged", async () => {
    const pending: Message = {
      id: "approval",
      role: "assistant",
      toolCalls: [
        {
          id: "approval-id",
          type: "function",
          function: { name: "scheduleTime", arguments: "{}" },
        },
      ],
    };
    const completed: Message = {
      id: "original-result",
      role: "tool",
      toolCallId: orphan.id,
      content: '{"status":"rendered"}',
    };
    const request = input([messages[0], completed, pending]);
    const agent = new CaptureAgent();
    await collect(new A2UIMiddleware(), request, agent);
    expect(agent.input!.messages).toEqual(request.messages);
  });

  it("does not recover calls during an approval resume", async () => {
    const request = {
      ...input(messages),
      forwardedProps: { command: { resume: "approved" } },
    };
    const agent = new CaptureAgent();
    await collect(new A2UIMiddleware(), request, agent);
    expect(agent.input!.messages).toEqual(messages);
  });

  it.each(["configured", "forwarded"])("a rejected fresh render with %s catalog ends visibly, never rendered", async (source) => {
    const agent = new CaptureAgent([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: orphan.id,
        toolCallName: orphan.name,
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: orphan.id,
        delta: JSON.stringify(orphan.args),
      },
      { type: EventType.TOOL_CALL_END, toolCallId: orphan.id },
    ] as BaseEvent[]);
    const schema = { catalogId: "dashboard", components: {
      Row: { type: "object", required: ["children"] },
      Metric: { allOf: [{ $ref: "common_types.json#/$defs/ComponentCommon" }, { required: ["label", "value"] }] },
      PieChart: { type: "object" }, BarChart: { type: "object" },
    } };
    const request = input([]);
    if (source === "forwarded") request.context = [{ description: A2UI_SCHEMA_CONTEXT_DESCRIPTION, value: JSON.stringify(schema) }];
    const events = await collect(new A2UIMiddleware(source === "configured" ? { schema } : {}), request, agent);
    expect(
      events.filter((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toEqual([
      expect.objectContaining({
        toolCallId: orphan.id,
        content: expect.stringContaining('"status":"failed"'),
      }),
    ]);
    expect(events.at(-2)).toMatchObject({
      type: EventType.ACTIVITY_SNAPSHOT,
      content: { status: "failed" },
    });
  });
  it("reports a valid surface as submitted, not confirmed browser rendering", async () => {
    const agent = new CaptureAgent([
      { type: EventType.TOOL_CALL_START, toolCallId: "valid", toolCallName: "render_a2ui" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "valid", delta: JSON.stringify({ surfaceId: "valid", components: [{ id: "root", component: "Text", text: "Hello" }] }) },
      { type: EventType.TOOL_CALL_END, toolCallId: "valid" },
    ] as BaseEvent[]);
    const events = await collect(new A2UIMiddleware(), input([]), agent);
    expect(events).toContainEqual(expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, toolCallId: "valid", content: JSON.stringify({ status: "submitted", renderingConfirmed: false }) }));
  });

});
