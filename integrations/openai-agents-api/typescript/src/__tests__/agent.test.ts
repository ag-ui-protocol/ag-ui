import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import type { BackendTool } from "../types";
import {
  collect,
  FakeAgentsApi,
  makeAgent,
  runInput,
  types,
} from "./fake-agents-api";

const user = (id: string, content: string) => ({
  id,
  role: "user" as const,
  content,
});
const toolMessage = (id: string, toolCallId: string, content: string) => ({
  id,
  role: "tool" as const,
  toolCallId,
  content,
});

const textOf = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => (event as unknown as { delta: string }).delta)
    .join("");

const finished = (events: BaseEvent[]) =>
  events.find((event) => event.type === EventType.RUN_FINISHED) as unknown as {
    outcome?: {
      type: string;
      interrupts?: Array<Record<string, any>>;
      pendingToolCallIds?: string[];
    };
  };

const CHANGE_BACKGROUND = {
  name: "change_background",
  description: "Change the background",
  parameters: {
    type: "object",
    properties: { background: { type: "string" } },
  },
};

describe("OpenAIAgentsAgent", () => {
  it("creates a session for a new thread and streams the answer", async () => {
    const fake = new FakeAgentsApi();
    fake.onCreate = (sessionId) => {
      fake.reasoning(sessionId, "Thinking about greetings.");
      fake.text(sessionId, "Hello there!");
      fake.completeTurn(sessionId);
    };
    const events = await collect(
      makeAgent(fake),
      runInput({
        messages: [user("u1", "Hi")],
        context: [{ description: "The user's name", value: "Bob" }],
        state: { mood: "happy" },
      }),
    );

    expect(types(events)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(textOf(events)).toBe("Hello there!");

    const created = fake.creates[0] as {
      input: Array<{ content: Array<{ text: string }> }>;
      environment: unknown;
    };
    expect(created.environment).toEqual({ type: "none" });
    const parts = created.input[0].content.map((part) => part.text);
    expect(parts[0]).toContain("- The user's name: Bob");
    expect(parts[0]).toContain('{"mood":"happy"}');
    expect(parts[1]).toBe("Hi");
  });

  it("emits a text message once when the answer arrives without deltas", async () => {
    const fake = new FakeAgentsApi();
    fake.onCreate = (sessionId) => {
      fake.text(sessionId, "Whole answer", { stream: false });
      fake.completeTurn(sessionId);
    };
    const events = await collect(
      makeAgent(fake),
      runInput({ messages: [user("u1", "Hi")] }),
    );
    expect(textOf(events)).toBe("Whole answer");
  });

  it("parks on a frontend tool call and resumes the same turn with the client's result", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake);
    let sessionId = "";
    fake.onCreate = (id) => {
      sessionId = id;
      fake.text(id, "Changing it.");
      fake.callFunctions(id, [
        {
          callId: "call_bg",
          name: "change_background",
          args: { background: "blue" },
        },
      ]);
    };

    const first = await collect(
      agent,
      runInput({
        messages: [user("u1", "Make it blue")],
        tools: [CHANGE_BACKGROUND],
      }),
    );
    const start = first.find(
      (event) => event.type === EventType.TOOL_CALL_START,
    ) as unknown as Record<string, string>;
    expect(start.toolCallName).toBe("change_background");
    expect(start.parentMessageId).toBeDefined();
    expect(
      first.find((event) => event.type === EventType.TOOL_CALL_ARGS),
    ).toMatchObject({ delta: '{"background":"blue"}' });
    expect(finished(first).outcome).toEqual({
      type: "success",
      pendingToolCallIds: ["call_bg"],
    });
    const createdTools = (
      fake.creates[0] as { agent: { tools: Array<{ name: string }> } }
    ).agent.tools;
    expect(createdTools.map((tool) => tool.name)).toEqual([
      "change_background",
    ]);

    // The stream replays the active turn on reconnect; the call must not be surfaced twice.
    fake.replay.set(sessionId, [
      fake.functionCallItem(sessionId, "call_bg", "change_background", {
        background: "blue",
      }),
    ]);
    fake.onSubmit = (id) => {
      fake.emit(id, {
        type: "agent.session.in_progress",
        event_id: "e",
        session: { ...fake.session(id), status: "in_progress" },
      } as never);
      fake.text(id, "Done, it is blue.");
      fake.completeTurn(id);
    };
    const second = await collect(
      agent,
      runInput({
        messages: [
          user("u1", "Make it blue"),
          {
            id: "a1",
            role: "assistant",
            toolCalls: [
              {
                id: "call_bg",
                type: "function",
                function: { name: "change_background", arguments: "{}" },
              },
            ],
          },
          toolMessage("t1", "call_bg", "Background changed"),
        ],
        tools: [CHANGE_BACKGROUND],
      }),
    );

    expect(fake.submissions).toEqual([
      [
        {
          type: "agent.session.input.tool_result",
          turn_id: "turn_1",
          call_id: "call_bg",
          success: true,
          output: "Background changed",
        },
      ],
    ]);
    expect(types(second)).not.toContain(EventType.TOOL_CALL_START);
    expect(textOf(second)).toBe("Done, it is blue.");
    expect(fake.creates).toHaveLength(1);
    expect(fake.updates).toHaveLength(0);
  });

  it("sends only new user messages to an existing session and updates tools when they change", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake);
    fake.onCreate = (id) => {
      fake.text(id, "First answer");
      fake.completeTurn(id);
    };
    await collect(agent, runInput({ messages: [user("u1", "First")] }));

    fake.onSubmit = (id) => {
      fake.text(id, "Second answer");
      fake.completeTurn(id);
    };
    const events = await collect(
      agent,
      runInput({
        messages: [
          user("u1", "First"),
          { id: "a1", role: "assistant", content: "First answer" },
          user("u2", "Second"),
        ],
        tools: [CHANGE_BACKGROUND],
      }),
    );

    expect(textOf(events)).toBe("Second answer");
    expect(fake.updates).toHaveLength(1);
    expect(
      (fake.updates[0].body as { agent: { tools: Array<{ name: string }> } })
        .agent.tools[0].name,
    ).toBe("change_background");
    expect(fake.submissions[0]).toEqual([
      {
        type: "agent.session.input.message",
        input: [
          { role: "user", content: [{ type: "input_text", text: "Second" }] },
        ],
      },
    ]);
  });

  it("runs backend tools on the server and returns their results to the agent", async () => {
    const fake = new FakeAgentsApi();
    const weather: BackendTool<{ location: string }> = {
      name: "get_weather",
      description: "Weather",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
      },
      handler: ({ location }, context) => {
        context.setState({ lastLocation: location });
        return { location, temperature: 21 };
      },
    };
    fake.onCreate = (id) =>
      fake.callFunctions(id, [
        { callId: "call_w", name: "get_weather", args: { location: "Paris" } },
      ]);
    fake.onSubmit = (id) => {
      fake.text(id, "It is 21 degrees.");
      fake.completeTurn(id);
    };

    const events = await collect(
      makeAgent(fake, { backendTools: [weather] }),
      runInput({ messages: [user("u1", "Weather?")] }),
    );

    expect(fake.submissions[0]).toEqual([
      {
        type: "agent.session.input.tool_result",
        turn_id: "turn_1",
        call_id: "call_w",
        success: true,
        output: '{"location":"Paris","temperature":21}',
      },
    ]);
    expect(
      events.find((event) => event.type === EventType.STATE_SNAPSHOT),
    ).toMatchObject({ snapshot: { lastLocation: "Paris" } });
    expect(
      events.find((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({
      toolCallId: "call_w",
      content: '{"location":"Paris","temperature":21}',
    });
    expect(textOf(events)).toBe("It is 21 degrees.");
    expect(finished(events).outcome).toBeUndefined();
  });

  it("reports a failing backend tool to the agent as an unsuccessful result", async () => {
    const fake = new FakeAgentsApi();
    const broken: BackendTool = {
      name: "broken",
      description: "Fails",
      parameters: { type: "object", properties: {} },
      handler: () => {
        throw new Error("database unavailable");
      },
    };
    fake.onCreate = (id) =>
      fake.callFunctions(id, [{ callId: "call_x", name: "broken", args: {} }]);
    fake.onSubmit = (id) => fake.completeTurn(id);

    await collect(
      makeAgent(fake, { backendTools: [broken] }),
      runInput({ messages: [user("u1", "Go")] }),
    );
    expect(fake.submissions[0][0]).toMatchObject({
      success: false,
      error: "database unavailable",
    });
  });

  it("ends the run with an interrupt and resumes the tool with the user's answer", async () => {
    const fake = new FakeAgentsApi();
    const seen: unknown[] = [];
    const schedule: BackendTool<{ topic: string }> = {
      name: "schedule_meeting",
      description: "Schedule",
      parameters: { type: "object", properties: { topic: { type: "string" } } },
      handler: ({ topic }, context) => {
        seen.push(context.resume?.payload);
        if (!context.resume)
          context.interrupt({
            reason: "schedule_meeting",
            message: "Pick a time",
            payload: { topic },
          });
        return `Scheduled ${topic} at ${(context.resume!.payload as { time: string }).time}`;
      },
    };
    const agent = makeAgent(fake, { backendTools: [schedule] });
    fake.onCreate = (id) =>
      fake.callFunctions(id, [
        {
          callId: "call_m",
          name: "schedule_meeting",
          args: { topic: "Pricing" },
        },
      ]);

    const first = await collect(
      agent,
      runInput({ messages: [user("u1", "Book a call")] }),
    );
    const outcome = finished(first).outcome!;
    expect(outcome.type).toBe("interrupt");
    expect(outcome.interrupts![0]).toMatchObject({
      id: "call_m",
      reason: "schedule_meeting",
      message: "Pick a time",
      toolCallId: "call_m",
      metadata: {
        toolName: "schedule_meeting",
        arguments: { topic: "Pricing" },
        payload: { topic: "Pricing" },
      },
    });
    expect(fake.submissions).toHaveLength(0);

    fake.onSubmit = (id) => {
      fake.text(id, "Booked.");
      fake.completeTurn(id);
    };
    const second = await collect(
      agent,
      runInput({
        messages: [user("u1", "Book a call")],
        resume: [
          {
            interruptId: "call_m",
            status: "resolved",
            payload: { time: "10:00" },
          },
        ],
      }),
    );
    expect(seen).toEqual([undefined, { time: "10:00" }]);
    expect(fake.submissions[0][0]).toMatchObject({
      call_id: "call_m",
      success: true,
      output: "Scheduled Pricing at 10:00",
    });
    expect(
      second.find((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toMatchObject({ toolCallId: "call_m" });
    expect(textOf(second)).toBe("Booked.");
  });

  it("asks for approval before running a tool and does not run it when rejected", async () => {
    const fake = new FakeAgentsApi();
    let ran = 0;
    const expense: BackendTool<{ amount: number }> = {
      name: "record_expense",
      description: "Record",
      parameters: {
        type: "object",
        properties: { amount: { type: "number" } },
      },
      requiresApproval: true,
      handler: ({ amount }) => {
        ran++;
        return { recorded: amount };
      },
    };
    const agent = makeAgent(fake, { backendTools: [expense] });
    fake.onCreate = (id) =>
      fake.callFunctions(id, [
        { callId: "call_e", name: "record_expense", args: { amount: 42 } },
      ]);

    const first = await collect(
      agent,
      runInput({ messages: [user("u1", "Record $42")] }),
    );
    expect(finished(first).outcome!.interrupts![0]).toMatchObject({
      id: "call_e",
      reason: "tool_approval",
      metadata: { toolName: "record_expense", arguments: { amount: 42 } },
    });

    fake.onSubmit = (id) => fake.completeTurn(id);
    await collect(
      agent,
      runInput({
        messages: [user("u1", "Record $42")],
        resume: [
          {
            interruptId: "call_e",
            status: "resolved",
            payload: { approved: false },
          },
        ],
      }),
    );
    expect(ran).toBe(0);
    expect(fake.submissions[0][0]).toMatchObject({
      call_id: "call_e",
      success: false,
    });
  });

  it("runs an approved tool, with edited arguments when the client sends them", async () => {
    const fake = new FakeAgentsApi();
    const calls: unknown[] = [];
    const expense: BackendTool<{ amount: number }> = {
      name: "record_expense",
      description: "Record",
      parameters: {
        type: "object",
        properties: { amount: { type: "number" } },
      },
      requiresApproval: (args) => args.amount > 10,
      handler: (args) => {
        calls.push(args);
        return "ok";
      },
    };
    const agent = makeAgent(fake, { backendTools: [expense] });
    fake.onCreate = (id) =>
      fake.callFunctions(id, [
        { callId: "call_e", name: "record_expense", args: { amount: 42 } },
      ]);
    await collect(agent, runInput({ messages: [user("u1", "Record $42")] }));

    fake.onSubmit = (id) => fake.completeTurn(id);
    await collect(
      agent,
      runInput({
        messages: [user("u1", "Record $42")],
        resume: [
          {
            interruptId: "call_e",
            status: "resolved",
            payload: { approved: true, editedArgs: { amount: 40 } },
          },
        ],
      }),
    );
    expect(calls).toEqual([{ amount: 40 }]);
    expect(fake.submissions[0][0]).toMatchObject({
      success: true,
      output: "ok",
    });
  });

  it("publishes predicted state and settles it from the tool arguments", async () => {
    const fake = new FakeAgentsApi();
    fake.onCreate = (id) =>
      fake.callFunctions(id, [
        {
          callId: "call_d",
          name: "write_document",
          args: { document: "Once upon a time" },
        },
      ]);
    const events = await collect(
      makeAgent(fake, {
        predictState: [
          {
            stateKey: "document",
            tool: "write_document",
            toolArgument: "document",
          },
        ],
      }),
      runInput({
        messages: [user("u1", "Write a story")],
        tools: [
          {
            name: "write_document",
            description: "Write",
            parameters: {
              type: "object",
              properties: { document: { type: "string" } },
            },
          },
        ],
        state: { document: "" },
      }),
    );
    const order = types(events);
    expect(order.indexOf(EventType.CUSTOM)).toBeLessThan(
      order.indexOf(EventType.TOOL_CALL_START),
    );
    expect(order.indexOf(EventType.STATE_SNAPSHOT)).toBeLessThan(
      order.indexOf(EventType.TOOL_CALL_END),
    );
    expect(
      events.find((event) => event.type === EventType.CUSTOM),
    ).toMatchObject({
      name: "PredictState",
      value: [
        {
          state_key: "document",
          tool: "write_document",
          tool_argument: "document",
        },
      ],
    });
    expect(
      events.find((event) => event.type === EventType.STATE_SNAPSHOT),
    ).toMatchObject({ snapshot: { document: "Once upon a time" } });
  });

  it("waits for parallel calls the API reports one at a time before handing them to the client", async () => {
    const fake = new FakeAgentsApi();
    fake.onCreate = (id) => {
      fake.callFunctions(id, [
        {
          callId: "call_a",
          name: "change_background",
          args: { background: "red" },
        },
      ]);
      setTimeout(
        () =>
          fake.callFunctions(id, [
            {
              callId: "call_a",
              name: "change_background",
              args: { background: "red" },
            },
            {
              callId: "call_b",
              name: "change_background",
              args: { background: "blue" },
            },
          ]),
        10,
      );
    };
    const events = await collect(
      makeAgent(fake, { clientToolSettleMs: 60 }),
      runInput({
        messages: [user("u1", "Two colors")],
        tools: [CHANGE_BACKGROUND],
      }),
    );
    expect(
      events.filter((event) => event.type === EventType.TOOL_CALL_START),
    ).toHaveLength(2);
    expect(finished(events).outcome).toEqual({
      type: "success",
      pendingToolCallIds: ["call_a", "call_b"],
    });
  });

  it("turns a failed turn into RUN_ERROR with the API's code", async () => {
    const fake = new FakeAgentsApi();
    fake.onCreate = (id) =>
      fake.failTurn(id, "rate_limit_exceeded", "Slow down");
    const events = await collect(
      makeAgent(fake),
      runInput({ messages: [user("u1", "Hi")] }),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "rate_limit_exceeded",
      message: "Slow down",
    });
  });

  it("reports API errors with their status and code", async () => {
    const fake = new FakeAgentsApi();
    (
      fake.client.beta.agents.sessions as unknown as { create: unknown }
    ).create = async () => {
      throw Object.assign(new Error("404 The model 'nope' does not exist"), {
        status: 404,
        code: "model_not_found",
      });
    };
    const events = await collect(
      makeAgent(fake),
      runInput({ messages: [user("u1", "Hi")] }),
    );
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "model_not_found",
      message: "OpenAI Agents API error (404): The model 'nope' does not exist",
    });
  });

  it("finishes immediately when there is nothing to send", async () => {
    const fake = new FakeAgentsApi();
    const events = await collect(makeAgent(fake), runInput({ messages: [] }));
    expect(types(events)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
    expect(fake.creates).toHaveLength(0);
  });

  it("cancels the turn when the client unsubscribes mid-run", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake);
    fake.onCreate = (id) => fake.text(id, "Working on it", { stream: true });
    const seen: BaseEvent[] = [];
    const subscription = agent
      .run(runInput({ messages: [user("u1", "Long task")] }))
      .subscribe((event) => seen.push(event));
    await new Promise((resolve) => setTimeout(resolve, 30));
    subscription.unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.submissions.at(-1)).toEqual([
      { type: "agent.session.input.cancel" },
    ]);
    expect(seen.some((event) => event.type === EventType.RUN_FINISHED)).toBe(
      false,
    );
  });

  it("answers an unanswered frontend call when the user moves on", async () => {
    const fake = new FakeAgentsApi();
    const agent = makeAgent(fake);
    fake.onCreate = (id) =>
      fake.callFunctions(id, [
        { callId: "call_hitl", name: "change_background", args: {} },
      ]);
    await collect(
      agent,
      runInput({ messages: [user("u1", "Do it")], tools: [CHANGE_BACKGROUND] }),
    );

    fake.onSubmit = (id) => fake.completeTurn(id);
    await collect(
      agent,
      runInput({
        messages: [
          user("u1", "Do it"),
          user("u2", "Never mind, something else"),
        ],
        tools: [CHANGE_BACKGROUND],
      }),
    );
    const [toolResult, message] = fake.submissions[0];
    expect(toolResult).toMatchObject({
      type: "agent.session.input.tool_result",
      call_id: "call_hitl",
      success: true,
    });
    expect(message).toMatchObject({ type: "agent.session.input.message" });
  });

  it("starts a new session with the earlier conversation when the thread has no session", async () => {
    const fake = new FakeAgentsApi();
    fake.onCreate = (id) => fake.completeTurn(id);
    await collect(
      makeAgent(fake),
      runInput({
        messages: [
          user("u1", "My name is Ada"),
          { id: "a1", role: "assistant", content: "Hi Ada" },
          user("u2", "What is my name?"),
        ],
      }),
    );
    const parts = (
      fake.creates[0] as { input: Array<{ content: Array<{ text: string }> }> }
    ).input[0].content.map((part) => part.text);
    expect(parts[0]).toContain("User: My name is Ada");
    expect(parts[0]).toContain("Assistant: Hi Ada");
    expect(parts.at(-1)).toBe("What is my name?");
  });
});
