/**
 * `forwardedProps` comes from the client. These tests drive the real adapter
 * (`runAgentStream` -> `prepareStream`) against a stubbed LangGraph Platform
 * client and check what reaches `threads.updateState` and `runs.stream`:
 *
 * - a client-chosen `nodeName` must not decide where the graph continues;
 *   only the thread's own history can (same rule as the Python adapter);
 * - a continue writes nothing and sends no input: it resumes only the
 *   thread's pending tasks, so it cannot skip a node;
 * - only an allowlist of `forwardedProps` reaches `runs.stream`: the run
 *   config, context, checkpoint and every other run option are the operator's;
 * - `forwardedProps.command` may carry `resume`, never `goto` or `update`.
 *
 * The Platform client is a stub, so this is unit-level proof of what the
 * adapter sends, not an end-to-end run against a LangGraph server.
 *
 * The node-name tests are defensive. `runAgentStream` resets `activeRun`, and
 * only `handleNodeChange` sets `activeRun.nodeName`, after the continue check,
 * so no released code path brings a client `nodeName` into continue mode
 * today. The tests put the name where the continue check reads it (as a
 * subclass that overrides `prepareStream` could) and check that the history
 * guard still refuses it.
 */
import { describe, it, expect, vi } from "vitest";
import { LangGraphAgent } from "../agent";

const GRAPH = {
  nodes: [
    { id: "__start__" },
    { id: "check_permission" },
    { id: "sensitive_action" },
    { id: "__end__" },
  ],
  edges: [
    { source: "__start__", target: "check_permission" },
    {
      source: "check_permission",
      target: "sensitive_action",
      conditional: true,
    },
    { source: "check_permission", target: "__end__", conditional: true },
    { source: "sensitive_action", target: "__end__" },
  ],
};

interface Setup {
  history?: any[];
  assistantConfig?: Record<string, unknown>;
  /** The thread's current values (`threads.getState`). */
  stateValues?: Record<string, unknown>;
  /** Override `input_schema.properties`. */
  inputProperties?: Record<string, unknown>;
  /** The thread's pending tasks (`threads.getState`), interrupts included. */
  tasks?: any[];
}

// The thread already holds the message `input()` sends, so a request built
// with `input()` adds no new message.
const SAME_TURN = { messages: [{ id: "m1", type: "human", content: "go" }] };

function buildAgent({
  history = [],
  assistantConfig,
  stateValues = { messages: [] },
  inputProperties = { messages: {} },
  tasks = [],
}: Setup = {}) {
  const agent = new LangGraphAgent({
    graphId: "gate",
    deploymentUrl: "http://localhost:8000",
    ...(assistantConfig ? { assistantConfig } : {}),
  } as any);

  (agent as any).assistant = {
    assistant_id: "asst-1",
    graph_id: "gate",
    config: { configurable: {} },
  };

  const streamCalls: any[] = [];
  const updateState = vi
    .fn()
    .mockResolvedValue({ checkpoint: { checkpoint_id: "ck-update" } });
  const getHistory = vi.fn().mockResolvedValue(history);
  (agent as any).client = {
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      create: vi.fn().mockResolvedValue({ thread_id: "thread-1" }),
      getState: vi.fn().mockResolvedValue({ values: stateValues, tasks }),
      getHistory,
      updateState,
    },
    assistants: {
      search: vi.fn().mockResolvedValue([]),
      getGraph: vi.fn().mockResolvedValue(GRAPH),
      getSchemas: vi.fn().mockResolvedValue({
        // `approved` is a private channel: in the state schema, not the input.
        input_schema: { properties: inputProperties },
        output_schema: { properties: { messages: {}, result: {} } },
        state_schema: {
          properties: { messages: {}, approved: {}, result: {} },
        },
        config_schema: { properties: { tenant: {} } },
      }),
    },
    runs: {
      stream: vi
        .fn()
        .mockImplementation((_t: string, _a: string, payload: any) => {
          streamCalls.push(payload);
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => ({ done: true, value: undefined }) };
            },
          };
        }),
    },
  };

  return { agent, streamCalls, updateState, getHistory };
}

function subscriber() {
  return {
    next: vi.fn(),
    error: vi.fn(),
    complete: vi.fn(),
    closed: false,
  } as any;
}

function input(
  forwardedProps: Record<string, unknown>,
  state: Record<string, unknown> = {},
) {
  return {
    runId: "run-1",
    threadId: "thread-1",
    state,
    messages: [{ id: "m1", role: "user", content: "go" }],
    tools: [],
    context: [],
    forwardedProps,
  } as any;
}

// A thread whose latest checkpoint was written by a step that ran `node`.
function historyAfter(node: string) {
  return [
    {
      values: {},
      next: [],
      metadata: { source: "loop" },
      checkpoint: { checkpoint_id: "ck-2" },
    },
    {
      values: {},
      next: [node],
      metadata: { source: "loop" },
      checkpoint: { checkpoint_id: "ck-1" },
    },
  ];
}

// Put the client node name where the continue check reads it, as a subclass
// that overrides `prepareStream` could. No released path does this today; see
// the file header.
function withClientNodeName(agent: LangGraphAgent) {
  const prepare = agent.prepareStream.bind(agent);
  vi.spyOn(agent, "prepareStream").mockImplementation(async (i, m) => {
    agent.activeRun!.nodeName = i.forwardedProps?.nodeName;
    return prepare(i, m);
  });
}

describe("client control over where and how a LangGraph run resumes", () => {
  it("a nodeName on a new thread does not skip nodes: the run starts at START", async () => {
    const { agent, streamCalls, updateState } = buildAgent();
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "sensitive_action" }, { approved: true }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls).toHaveLength(1);
    // A start run: input present, and filtered to the input schema.
    expect(streamCalls[0].input).toBeTruthy();
    expect(streamCalls[0].input).not.toHaveProperty("approved");
  });

  it("a nodeName is refused when the latest checkpoint came from updateState", async () => {
    // A continue (or a regenerate fork) wrote the latest checkpoint and the
    // run stopped before a step. The checkpoint before it lists
    // `sensitive_action` as next, but that node never ran.
    const { agent, updateState } = buildAgent({
      history: [
        {
          values: {},
          next: ["sensitive_action"],
          metadata: { source: "update" },
          checkpoint: { checkpoint_id: "ck-2" },
        },
        {
          values: {},
          next: ["sensitive_action"],
          metadata: { source: "loop" },
          checkpoint: { checkpoint_id: "ck-1" },
        },
      ],
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "sensitive_action" }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
  });

  it("a nodeName the thread's history does not back is ignored", async () => {
    const { agent, updateState } = buildAgent({
      history: historyAfter("some_other_node"),
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "sensitive_action" }, { approved: true }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
  });

  it("continuing from the node that ran last writes no client state", async () => {
    const { agent, updateState, streamCalls } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: SAME_TURN,
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }, { approved: true }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].input).toBeNull();
  });

  it("forwardedProps.config does not override the operator's assistant config", async () => {
    const { agent, streamCalls } = buildAgent({
      assistantConfig: { configurable: { tenant: "operator-tenant" } },
    });

    await agent.runAgentStream(
      input({
        config: {
          configurable: { tenant: "attacker-tenant" },
          recursion_limit: 9999,
        },
      }),
      subscriber(),
    );

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].config?.configurable?.tenant).toBe("operator-tenant");
    expect(streamCalls[0].config?.recursion_limit).not.toBe(9999);
  });

  it("forwardedProps.command goto/update are not passed to the run", async () => {
    const { agent, streamCalls } = buildAgent();

    await agent.runAgentStream(
      input({
        command: { goto: "sensitive_action", update: { approved: true } },
      }),
      subscriber(),
    );

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].command?.goto).toBeUndefined();
    expect(streamCalls[0].command?.update).toBeUndefined();
  });

  it("a regenerate run also ignores client config and command", async () => {
    const { agent, streamCalls } = buildAgent({
      assistantConfig: { configurable: { tenant: "operator-tenant" } },
    });
    (agent as any).activeRun = { id: "run-1", threadId: "thread-1" };
    (agent as any).activeRun.schemaKeys = await agent.getSchemaKeys();
    (agent as any).getCheckpointByMessage = vi.fn().mockResolvedValue({
      values: { messages: [] },
      next: ["check_permission"],
      checkpoint: { checkpoint_id: "ck-1" },
    });

    await agent.prepareRegenerateStream(
      {
        ...input({
          config: { configurable: { tenant: "attacker-tenant" } },
          command: { goto: "sensitive_action", update: { approved: true } },
        }),
        messageCheckpoint: { id: "m1", type: "human", content: "go" },
      } as any,
      ["values"] as any,
    );

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].config?.configurable?.tenant).toBe("operator-tenant");
    expect(streamCalls[0].command).toBeUndefined();
  });

  it("forwardedProps.command.resume still resumes an interrupt", async () => {
    const { agent, streamCalls } = buildAgent();

    await agent.runAgentStream(
      input({ command: { resume: "approved", goto: "sensitive_action" } }),
      subscriber(),
    );

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].command).toEqual({ resume: "approved" });
  });

  it("forwardedProps.context does not reach the run", async () => {
    // LangGraph Platform merges `context` into `configurable`, so a client
    // context would override the operator config as `config` did.
    const { agent, streamCalls } = buildAgent({
      assistantConfig: { configurable: { tenant: "operator-tenant" } },
    });

    await agent.runAgentStream(
      input({ context: { tenant: "attacker-tenant", user_id: "victim" } }),
      subscriber(),
    );

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].context?.user_id).toBeUndefined();
    expect(streamCalls[0].context?.tenant).not.toBe("attacker-tenant");
  });

  it("forwardedProps.checkpoint and checkpointId do not reach the run", async () => {
    // A client-chosen checkpoint could replay a step whose `next` is the
    // sensitive action after a single approval.
    const { agent, streamCalls } = buildAgent();

    await agent.runAgentStream(
      input({
        checkpoint: { checkpoint_id: "ck-approved", checkpoint_ns: "" },
        checkpointId: "ck-approved",
      }),
      subscriber(),
    );

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]).not.toHaveProperty("checkpoint");
    expect(streamCalls[0]).not.toHaveProperty("checkpointId");
  });

  it("a regenerate run uses the adapter fork, not a client checkpoint", async () => {
    const { agent, streamCalls } = buildAgent();
    (agent as any).activeRun = { id: "run-1", threadId: "thread-1" };
    (agent as any).activeRun.schemaKeys = await agent.getSchemaKeys();
    (agent as any).getCheckpointByMessage = vi.fn().mockResolvedValue({
      values: { messages: [] },
      next: ["check_permission"],
      checkpoint: { checkpoint_id: "ck-1" },
    });

    await agent.prepareRegenerateStream(
      {
        ...input({
          checkpoint: { checkpoint_id: "ck-approved", checkpoint_ns: "" },
          checkpointId: "ck-approved",
        }),
        messageCheckpoint: { id: "m1", type: "human", content: "go" },
      } as any,
      ["values"] as any,
    );

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]).not.toHaveProperty("checkpoint");
    // `ck-update` is what the stubbed `threads.updateState` (the fork) returns.
    expect(streamCalls[0].checkpointId).toBe("ck-update");
  });

  it("only allowlisted forwardedProps reach the run", async () => {
    const { agent, streamCalls } = buildAgent();

    await agent.runAgentStream(
      input({
        streamSubgraphs: false,
        durability: "exit",
        webhook: "https://attacker.example/hook",
        interruptBefore: [],
        interruptAfter: [],
        multitaskStrategy: "rollback",
        onCompletion: "delete",
        metadata: { user_id: "victim" },
        afterSeconds: 3600,
      }),
      subscriber(),
    );

    expect(streamCalls).toHaveLength(1);
    const payload = streamCalls[0];
    expect(payload.streamSubgraphs).toBe(false);
    for (const key of [
      "durability",
      "webhook",
      "interruptBefore",
      "interruptAfter",
      "multitaskStrategy",
      "onCompletion",
      "metadata",
      "afterSeconds",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it("an empty input schema is an empty allowlist, not an open one", async () => {
    const { agent, updateState, streamCalls } = buildAgent({
      inputProperties: {},
    });

    await agent.runAgentStream(input({}, { approved: true }), subscriber());

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].input).not.toHaveProperty("approved");
  });

  it("a continue that changes an input channel starts a new run instead", async () => {
    // check_permission approved `public`. Continuing from it with `private`
    // would carry `private` past the check.
    const { agent, updateState, streamCalls } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: { ...SAME_TURN, resource: "public", approved: true },
      inputProperties: { messages: {}, resource: {} },
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }, { resource: "private" }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls).toHaveLength(1);
    // A start run: the input goes in at START, so the check runs again.
    expect(streamCalls[0].input).toMatchObject({ resource: "private" });
  });

  it("a continue that adds a message starts a new run instead", async () => {
    const { agent, updateState, streamCalls } = buildAgent({
      history: historyAfter("check_permission"),
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls[0].input?.messages).toHaveLength(1);
  });

  it("a continue with unchanged input still continues", async () => {
    const { agent, updateState, streamCalls } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: { ...SAME_TURN, resource: "public", approved: true },
      inputProperties: { messages: {}, resource: {} },
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }, { resource: "public" }),
      subscriber(),
    );

    // A continue: the thread resumes its own pending tasks.
    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].input).toBeNull();
  });

  it("an echo that differs only in key order is unchanged", async () => {
    const { agent, updateState, streamCalls } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: { ...SAME_TURN, filter: { a: 1, b: 2 } },
      inputProperties: { messages: {}, filter: {} },
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }, { filter: { b: 2, a: 1 } }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls[0].input).toBeNull();
  });

  it("a value that cannot be compared counts as changed", async () => {
    const { agent, streamCalls } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: { ...SAME_TURN, amount: 1 },
      inputProperties: { messages: {}, amount: {} },
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }, { amount: BigInt(1) }),
      subscriber(),
    );

    // A start run: the input goes in at START.
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].input).not.toBeNull();
  });
  it("a continue writes none of an unchanged input, so a reducer cannot change it", async () => {
    // check_permission approved amount 100. `amount` has an add reducer on the
    // graph, so writing the equal 100 again would store 200, which the check
    // never saw. The continue goes on but writes no client value.
    const { agent, updateState, streamCalls } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: { ...SAME_TURN, amount: 100, approved: true },
      inputProperties: { messages: {}, amount: {} },
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }, { amount: 100 }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls[0].input).toBeNull();
  });
  it("a node with a pending interrupt is not a continue point: the interrupt stays", async () => {
    // `check_permission` ran in the latest step and paused at an interrupt.
    // Writing as that node would replace the pending task and drop its
    // interrupt, while the client is still told the run is interrupted. The
    // request ends on the interrupt instead and writes nothing (same as the
    // Python adapter).
    const { agent, streamCalls, updateState } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: SAME_TURN,
      tasks: [
        {
          id: "task-1",
          name: "check_permission",
          interrupts: [{ value: "approve?", id: "int-1" }],
        },
      ],
    });
    withClientNodeName(agent);
    const sub = subscriber();

    await agent.runAgentStream(input({ nodeName: "check_permission" }), sub);

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls).toHaveLength(0);
    expect(sub.next).toHaveBeenCalledWith(
      expect.objectContaining({ type: "RUN_FINISHED" }),
    );
  });

  it("the node before an interrupted one is not a continue point either", async () => {
    // `check_permission` ran in the latest step; `sensitive_action` after it
    // is paused at an interrupt. A continue as `check_permission` would
    // schedule `sensitive_action` again and drop its interrupt.
    const { agent, streamCalls, updateState } = buildAgent({
      history: historyAfter("check_permission"),
      stateValues: SAME_TURN,
      tasks: [
        {
          id: "task-2",
          name: "sensitive_action",
          interrupts: [{ value: "approve?", id: "int-2" }],
        },
      ],
    });
    withClientNodeName(agent);

    await agent.runAgentStream(
      input({ nodeName: "check_permission" }),
      subscriber(),
    );

    expect(updateState).not.toHaveBeenCalled();
    expect(streamCalls).toHaveLength(0);
  });

  // With `durability: "exit"` LangGraph saves one checkpoint per run, so the
  // two latest checkpoints can come from different runs: the history check
  // cannot prove that the named node finished. These histories are the ones
  // a live `langgraph dev` server records (newest first) after two runs.
  describe("durability", () => {
    // START -> gate -> act; `gate` raised in two runs.
    const REFUSED_TWICE = {
      default: [
        { values: {}, next: ["gate"], metadata: { source: "loop", step: 2 } },
        {
          values: {},
          next: ["__start__"],
          metadata: { source: "input", step: 1 },
        },
      ],
      // Each run saved one "loop" checkpoint with `gate` still in `next`.
      exit: [
        { values: {}, next: ["gate"], metadata: { source: "loop", step: 2 } },
        { values: {}, next: ["gate"], metadata: { source: "loop", step: 0 } },
      ],
    };
    // START -> quote -> pay -> deliver, paused before `pay` in two runs.
    const PAUSED_TWICE = {
      default: [
        { values: {}, next: ["pay"], metadata: { source: "loop", step: 1 } },
        { values: {}, next: ["quote"], metadata: { source: "loop", step: 0 } },
      ],
      exit: [
        { values: {}, next: ["pay"], metadata: { source: "loop", step: 1 } },
        { values: {}, next: ["pay"], metadata: { source: "loop", step: 1 } },
      ],
    };

    for (const [name, history, nodeName] of [
      ["default: a gate that refused", REFUSED_TWICE.default, "gate"],
      ["default: a node that never ran", PAUSED_TWICE.default, "pay"],
      ["exit: a gate that refused", REFUSED_TWICE.exit, "gate"],
      ["exit: a node that never ran", PAUSED_TWICE.exit, "pay"],
    ] as const) {
      it(`${name} is not a continue point`, async () => {
        const { agent, updateState, streamCalls } = buildAgent({
          history: [...history],
          stateValues: SAME_TURN,
        });
        withClientNodeName(agent);

        await agent.runAgentStream(input({ nodeName }), subscriber());

        expect(updateState).not.toHaveBeenCalled();
        expect(streamCalls).toHaveLength(1);
        // A new run from START: the named node runs (again).
        expect(streamCalls[0].input).not.toBeNull();
      });

      it(`${name}: a continue the history check lets through cannot skip it`, async () => {
        const { agent, updateState, streamCalls } = buildAgent({
          history: [...history],
          stateValues: SAME_TURN,
        });
        withClientNodeName(agent);
        // Take the history check out: the continue alone must hold.
        vi.spyOn(agent as any, "ranInLatestStep").mockResolvedValue(true);

        await agent.runAgentStream(input({ nodeName }), subscriber());

        // No `asNode` write marks the node as finished, and no input is sent:
        // the run resumes the thread's pending `next`, the named node first.
        expect(updateState).not.toHaveBeenCalled();
        expect(streamCalls).toHaveLength(1);
        expect(streamCalls[0].input).toBeNull();
      });
    }

    it("a client cannot choose exit durability", async () => {
      const { agent, streamCalls } = buildAgent();

      await agent.runAgentStream(input({ durability: "exit" }), subscriber());

      expect(streamCalls[0]).not.toHaveProperty("durability");
    });
  });
});
