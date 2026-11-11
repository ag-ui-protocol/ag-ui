import assert from "node:assert/strict";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type Event, type Tool } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import {
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createExampleServer } from "@ag-ui/pi/examples/server";

async function fixture(
  t: TestContext,
  replies: FauxResponseStep[],
  customTools?: ToolDefinition[],
) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const provider = fauxProvider({ tokenSize: { min: 1, max: 2 }, tokensPerSecond: Infinity });
  provider.setResponses(replies);
  modelRuntime.registerNativeProvider(provider.provider);
  const server = createExampleServer({ modelRuntime, model: provider.getModel(), customTools });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server[Symbol.asyncDispose]());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/agentic_chat`;
  return { url, provider, agent: new HttpAgent({ url, threadId: "conversation" }) };
}

async function ask(agent: HttpAgent, id: string, text: string) {
  agent.addMessage({ id: `user-${id}`, role: "user", content: text });
  return run(agent, id);
}

async function run(agent: HttpAgent, runId: string, tools: Tool[] = []) {
  const events: Event[] = [];
  await agent.runAgent(
    { runId, tools },
    {
      onEvent({ event }) {
        events.push(EventSchema.parse(event));
      },
    },
  );
  return events;
}

test("HttpAgent delivers each new prompt once and restores the preceding conversation", async (t) => {
  const requests: TranscriptContext[] = [];
  function respond(context: TranscriptContext) {
    requests.push(context);
    const latest = context.messages.at(-1);
    assert.equal(latest?.role, "user");
    return fauxAssistantMessage(`You said ${contentText(latest.content)}`);
  }
  const { agent } = await fixture(t, [respond, respond]);
  for (const [runId, prompt] of [
    ["one", "Hello Pi"],
    ["two", "Another question"],
  ]) {
    const events = await ask(agent, runId, prompt);
    assert.deepEqual(
      events.filter((e) => e.type === EventType.RUN_STARTED).map((e) => [e.threadId, e.runId]),
      [["conversation", runId]],
    );
    assert.deepEqual(
      events.filter((e) => e.type === EventType.RUN_FINISHED).map((e) => [e.threadId, e.runId]),
      [["conversation", runId]],
    );
    assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
    assert.ok(events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT).length > 1);
    assert.equal(agent.messages.at(-1)?.content, `You said ${prompt}`);
  }
  const history = requests.map((request) =>
    request.messages.flatMap((m) =>
      m.role === "user" || m.role === "assistant" ? [[m.role, contentText(m.content)]] : [],
    ),
  );
  assert.deepEqual(history, [
    [["user", "Hello Pi"]],
    [
      ["user", "Hello Pi"],
      ["assistant", "You said Hello Pi"],
      ["user", "Another question"],
    ],
  ]);
});

test("HttpAgent receives a correlated native tool call and its executed result", async (t) => {
  const calls: string[] = [];
  const tool: ToolDefinition = {
    name: "ticket",
    label: "Ticket",
    description: "Issue a ticket",
    parameters: { type: "object", properties: {} },
    async execute(id) {
      calls.push(id);
      return { content: [{ type: "text", text: "ticket-42" }], details: {} };
    },
  };
  const { agent } = await fixture(
    t,
    [
      fauxAssistantMessage(fauxToolCall("ticket", {}, { id: "call-1" }), { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.at(-1);
        assert.equal(result?.role, "toolResult");
        assert.equal(contentText(result.content), "ticket-42");
        return fauxAssistantMessage("Issued your ticket");
      },
    ],
    [tool],
  );
  const events = await ask(agent, "ticket-run", "Issue a ticket");
  assert.deepEqual(calls, ["call-1"]);
  const toolEvents = events.filter((e) => "toolCallId" in e);
  assert.ok(toolEvents.every((event) => "toolCallId" in event && event.toolCallId === "call-1"));
  assert.deepEqual(
    toolEvents.map((e) => e.type),
    [
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ],
  );
  assert.ok(toolEvents[0].type === EventType.TOOL_CALL_START && toolEvents[0].parentMessageId);
  assert.ok(
    toolEvents[3].type === EventType.TOOL_CALL_RESULT && toolEvents[3].content === "ticket-42",
  );
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
});

test("a provider failure emits a public terminal error and a later run succeeds", async (t) => {
  const { agent } = await fixture(t, [
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "private provider diagnostics" }),
    fauxAssistantMessage("Recovered"),
  ]);
  const failed = await ask(agent, "failed", "First try");
  assert.deepEqual(
    failed
      .filter((e) => e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR)
      .map((e) => e.type),
    [EventType.RUN_ERROR],
  );
  assert.doesNotMatch(JSON.stringify(failed), /private provider diagnostics/);
  assert.equal((await ask(agent, "retry", "Try again")).at(-1)?.type, EventType.RUN_FINISHED);
});

test(
  "disconnect aborts the example's Pi session and releases the provider",
  { timeout: 10000 },
  async (t) => {
    let markStarted!: () => void;
    let markAborted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const { agent } = await fixture(t, [
      async (_context, options) => {
        markStarted();
        assert.ok(options?.signal);
        await once(options.signal, "abort");
        markAborted();
        return fauxAssistantMessage("cancelled", { stopReason: "aborted" });
      },
    ]);
    const running = ask(agent, "disconnect", "Hold");
    await started;
    agent.abortRun();
    await aborted;
    await running;
  },
);

test("a Flutter-style client executes a tool from the snapshot and resubmits its result", async (t) => {
  const tools = [
    {
      name: "calculate",
      description: "Calculate the expression on the client",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  ];
  const requests: TranscriptContext[] = [];
  const { agent } = await fixture(t, [
    (context) => {
      requests.push(context);
      const tool = getCurrentTools(context.messages).find((t) => t.name === "calculate");
      assert.deepEqual(tool?.parameters, tools[0].parameters);
      return fauxAssistantMessage(
        fauxToolCall("calculate", { expression: "12 * 7" }, { id: "calc-1" }),
        {
          stopReason: "toolUse",
        },
      );
    },
    (context) => {
      requests.push(context);
      const result = context.messages.filter((m) => m.role !== "system").at(-1);
      assert.equal(result?.role, "toolResult");
      assert.equal(result.toolCallId, "calc-1");
      assert.equal(contentText(result.content), '{"result":84}');
      return fauxAssistantMessage("The answer is 84.");
    },
  ]);
  agent.addMessage({ role: "user", id: "flutter-user", content: "Calculate 12 * 7" });
  const events = await run(agent, "propose", tools);
  assert.equal(requests.length, 1);
  assert.ok(!events.some((e) => e.type === EventType.TOOL_CALL_RESULT));
  const snapshot = events.at(-2);
  assert.equal(snapshot?.type, EventType.MESSAGES_SNAPSHOT);
  const proposal = snapshot.messages.at(-1);
  assert.equal(proposal?.role, "assistant");
  assert.deepEqual(proposal.toolCalls, [
    {
      id: "calc-1",
      type: "function",
      function: { name: "calculate", arguments: '{"expression":"12 * 7"}' },
    },
  ]);
  assert.ok(!snapshot.messages.some((m) => m.role === "tool"));
  const finish = events.at(-1);
  assert.equal(finish?.type, EventType.RUN_FINISHED);
  assert.deepEqual(finish.outcome, { type: "success", pendingToolCallIds: ["calc-1"] });

  agent.addMessage({
    role: "tool",
    id: "flutter-result",
    toolCallId: "calc-1",
    content: '{"result":84}',
  });
  await agent.runAgent({ runId: "resume", tools });
  assert.equal(requests.length, 2);
  assert.equal(agent.messages.at(-1)?.content, "The answer is 84.");
  assert.deepEqual(
    agent.messages.slice(0, -1).map((message) => message.id),
    ["flutter-user", proposal.id, "flutter-result"],
  );
  assert.deepEqual(
    requests[1].messages.filter((m) => m.role !== "system").map((m) => m.role),
    ["user", "assistant", "toolResult"],
  );
});

test("rendering a card ends the run silently, including on replay, until the user asks again", async (t) => {
  const tools = [
    {
      name: "render_card",
      description: "Render a card",
      parameters: { type: "object" },
    },
  ];
  const prompts = ["Show a card", "Do it again without saying Card rendered: after"];
  const { url, provider } = await fixture(
    t,
    prompts.map((title, index) =>
      fauxAssistantMessage(fauxToolCall("render_card", { title }, { id: `card-${index}` }), {
        stopReason: "toolUse",
      }),
    ),
  );
  const agent = new HttpAgent({
    url: new URL("/tool_based_generative_ui", url).href,
    threadId: "cards",
  });
  for (const [index, prompt] of prompts.entries()) {
    agent.addMessage({ id: `user-${index}`, role: "user", content: prompt });
    await run(agent, `propose-${index}`, tools);
    const proposal = agent.messages.at(-1);
    assert.equal(proposal?.role, "assistant");
    const id = `card-${index}`;
    assert.deepEqual(
      proposal.toolCalls?.map((call) => [call.id, call.function.name]),
      [[id, "render_card"]],
    );
    agent.addMessage({
      id: `result-${index}`,
      role: "tool",
      toolCallId: id,
      content: '{"rendered":true}',
    });
    const acknowledged = structuredClone(agent.messages);
    for (const attempt of ["ack", "replay"]) {
      const events = await run(agent, `${attempt}-${index}`, tools);
      assert.deepEqual(
        events.map((event) => event.type),
        [EventType.RUN_STARTED, EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED],
      );
      const snapshot = events[1];
      assert.equal(snapshot.type, EventType.MESSAGES_SNAPSHOT);
      assert.deepEqual(snapshot.messages, acknowledged);
      assert.deepEqual(agent.messages, acknowledged);
      assert.equal(provider.state.callCount, index + 1);
    }
  }
});

test("only successful card-only batches stop before another provider turn on the card route", async (t) => {
  const cases = [
    {
      route: "agentic_chat",
      names: ["render_card"],
      content: '{"rendered":true}',
    },
    {
      route: "tool_based_generative_ui",
      names: ["calculate", "render_card"],
      content: '{"rendered":true}',
    },
    {
      route: "tool_based_generative_ui",
      names: ["render_card"],
      content: '{"rendered":false}',
    },
    {
      route: "tool_based_generative_ui",
      names: ["render_card"],
      content: "invalid JSON",
    },
    {
      route: "tool_based_generative_ui",
      names: ["render_card"],
      content: '{"rendered":true}',
      error: "failed",
    },
  ];
  const { url, provider } = await fixture(
    t,
    cases.map(() => fauxAssistantMessage("Continued")),
  );
  for (const [index, { route, names, content, error }] of cases.entries()) {
    const agent = new HttpAgent({
      url: new URL(`/${route}`, url).href,
      threadId: `thread-${index}`,
    });
    const tools = names.map((name) => ({
      name,
      description: name,
      parameters: { type: "object" },
    }));
    agent.addMessage({ id: "user", role: "user", content: "Run the tools" });
    agent.addMessage({
      id: "assistant",
      role: "assistant",
      toolCalls: names.map((name) => ({
        id: name,
        type: "function",
        function: { name, arguments: "{}" },
      })),
    });
    for (const name of names) {
      agent.addMessage({
        id: `result-${name}`,
        role: "tool",
        toolCallId: name,
        content,
        error,
      });
    }
    await run(agent, `continue-${index}`, tools);
    assert.equal(agent.messages.at(-1)?.content, "Continued");
    assert.equal(provider.state.callCount, index + 1);
  }
});

test("the browser preflight permits a local Flutter web origin", async (t) => {
  const { url } = await fixture(t, []);
  const headers = {
    Origin: "http://localhost:5080",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
  };
  const preflight = await fetch(url, { method: "OPTIONS", headers });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), headers.Origin);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  const remote = await fetch(url, {
    method: "OPTIONS",
    headers: { ...headers, Origin: "https://other.example" },
  });
  assert.equal(remote.status, 403);
});

test("rejects unmatched tool results and invalid tool declarations before starting Pi", async (t) => {
  const { url } = await fixture(t, []);
  const input = {
    threadId: "thread",
    runId: "invalid",
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    messages: [{ role: "user", id: "question", content: "Hello" }],
  };
  for (const body of [
    {
      ...input,
      tools: [{ name: "*", description: "Invalid name", parameters: { type: "object" } }],
    },
    {
      ...input,
      messages: [
        ...input.messages,
        { role: "tool", id: "reply", toolCallId: "absent", content: "42" },
      ],
    },
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});
