/**
 * Request-scoped state must reach the underlying Strands invocation (#2880).
 *
 * Port of the Python adapter's `test_invocation_state.py`, plus the transport
 * cases its `test_endpoint.py` and `test_multiagent_orchestrator.py` cover.
 * The host passes `invocationState` to `run()`, or an `invocationStateProvider`
 * to either Express entry point, and Strands hands it to every hook and tool of
 * that run. Without either, the Strands call is made exactly as before.
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import {
  Agent,
  BeforeInvocationEvent,
  Graph,
  tool,
  type AgentStreamEvent,
  type InvocationState,
  type Plugin,
  type ToolContext,
} from "@strands-agents/sdk";
import { z } from "zod";

import { StrandsAgent, type StrandsAgentRunOptions } from "../agent";
import { addStrandsExpressEndpoint } from "../endpoint";
import { createStrandsApp } from "../server";
import {
  collect,
  expectCompletedRun,
  minimalRunInput,
  modelTurn,
  realStrandsAgent,
  ScriptedModel,
  scriptedStrandsAgent,
  soleInterruptId,
} from "./helpers";
import {
  FixedAgent,
  closeServer,
  listen,
  postRaw,
  runAgentInputPayload,
} from "./transport-harness";

const USER_TURN = minimalRunInput({
  messages: [{ id: "u1", role: "user", content: "go" } as never],
});

async function runWith(
  agent: StrandsAgent,
  input: RunAgentInput,
  options?: StrandsAgentRunOptions,
): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  for await (const e of agent.run(input, options)) out.push(e);
  return out;
}

/** A real tool that records the invocation state it ran with. */
function stateReadingTool(name = "lookup") {
  const seen: InvocationState[] = [];
  const instance = tool({
    name,
    description: "Reads the invocation state",
    inputSchema: z.object({}).passthrough(),
    callback: async (_input: unknown, context?: ToolContext) => {
      seen.push(context!.invocationState);
      // A top-level write, the way a hook or tool records something for later
      // in the same run. It must stay on this run's copy.
      context!.invocationState.writtenByTool = true;
      const persisted = context!.invocationState.persisted;
      if (Array.isArray(persisted)) persisted.push(`${name}-record`);
      return { ok: true };
    },
  });
  return { tool: instance, seen };
}

/** A plugin whose hook records the invocation state each invocation began with. */
function stateReadingPlugin() {
  const seen: InvocationState[] = [];
  const plugin: Plugin = {
    name: "state-reader",
    initAgent(agent) {
      agent.addHook(BeforeInvocationEvent, (event) => {
        seen.push(event.invocationState);
      });
    },
  };
  return { plugin, seen };
}

/** A stub agent recording every `stream()` call, as Python's `_CapturingCore`. */
function capturingAgent(events: unknown[] = []) {
  const calls: unknown[][] = [];
  const agent = scriptedStrandsAgent([], {
    stubOverrides: {
      async *stream(...args: unknown[]) {
        calls.push(args);
        for (const e of events) yield e as AgentStreamEvent;
      },
    } as Record<string, unknown>,
  });
  return { agent, calls };
}

function streamOptionsOf(calls: unknown[][]): Record<string, unknown> {
  expect(calls, "agent.stream() was never called").toHaveLength(1);
  return calls[0]![1] as Record<string, unknown>;
}

describe("invocationState on the single-agent path", () => {
  it("is forwarded to agent.stream() as a copy", async () => {
    const { agent, calls } = capturingAgent();
    const invocationState = { requestId: "request-1" };

    expectCompletedRun(
      await runWith(agent, minimalRunInput(), { invocationState }),
    );

    const forwarded = streamOptionsOf(calls).invocationState as InvocationState;
    expect(forwarded).toEqual({ requestId: "request-1" });
    expect(forwarded).not.toBe(invocationState);
    // The cancel signal still rides beside it.
    expect(streamOptionsOf(calls).cancelSignal).toBeInstanceOf(AbortSignal);

    forwarded.mutatedByStrands = true;
    expect(invocationState).toEqual({ requestId: "request-1" });
  });

  it("omitted, leaves the stream call exactly as it was", async () => {
    const { agent, calls } = capturingAgent();

    expectCompletedRun(await collect(agent));

    expect(Object.keys(streamOptionsOf(calls))).toEqual(["cancelSignal"]);
  });

  it("reaches hooks and tools on a real agent, never the model", async () => {
    const { tool: lookup, seen: toolSaw } = stateReadingTool();
    const { plugin, seen: hookSaw } = stateReadingPlugin();
    const { agent, model } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-1", name: "lookup", input: {} }),
        modelTurn.text("done"),
      ],
      { tools: [lookup], plugins: [plugin] },
    );
    const persisted: string[] = [];
    const invocationState = { tenantId: "tenant-42", persisted };

    expectCompletedRun(await runWith(agent, USER_TURN, { invocationState }));

    expect(hookSaw).toHaveLength(1);
    expect(toolSaw).toHaveLength(1);
    // One object for the whole run, shared by the hook and the tool.
    expect(toolSaw[0]).toBe(hookSaw[0]);
    expect(toolSaw[0]).toMatchObject({ tenantId: "tenant-42" });
    // A top-level write lands on the run's copy, a nested one on the host's
    // container, which is how a hook reports back to the host.
    expect(invocationState).not.toHaveProperty("writtenByTool");
    expect(persisted).toEqual(["lookup-record"]);
    // Nothing of it reaches the provider.
    expect(JSON.stringify(model.calls)).not.toContain("tenant-42");
  });

  it("gives each run its own copy of one reused object", async () => {
    const { tool: lookup, seen } = stateReadingTool();
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({ toolUseId: "tu-1", name: "lookup", input: {} }),
        modelTurn.text("first"),
        modelTurn.toolUse({ toolUseId: "tu-2", name: "lookup", input: {} }),
        modelTurn.text("second"),
      ],
      { tools: [lookup] },
    );
    const invocationState = { requestId: "shared" };

    expectCompletedRun(await runWith(agent, USER_TURN, { invocationState }));
    expectCompletedRun(await runWith(agent, USER_TURN, { invocationState }));

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    // Both runs started from the host's object, not from the first run's
    // copy with its write on it.
    expect(seen[1]).toEqual({ requestId: "shared", writtenByTool: true });
    expect(invocationState).toEqual({ requestId: "shared" });
  });

  it("is forwarded on a resumed run, which is a new invocation", async () => {
    const { tool: confirm, seen } = stateReadingTool("confirm_delete");
    const { agent } = realStrandsAgent(
      [
        modelTurn.toolUse({
          toolUseId: "tu-1",
          name: "confirm_delete",
          input: {},
        }),
        modelTurn.text("deleted"),
      ],
      {
        tools: [confirm],
        config: {
          toolBehaviors: { confirm_delete: { interruptOnCall: true } },
        },
      },
    );

    const paused = await runWith(agent, USER_TURN, {
      invocationState: { requestId: "request-1" },
    });
    expect(seen, "the gated tool ran before approval").toEqual([]);

    const resumed = await runWith(
      agent,
      minimalRunInput({
        resume: [
          {
            interruptId: soleInterruptId(paused),
            status: "resolved",
            payload: { approved: true },
          },
        ],
      } as Partial<RunAgentInput>),
      { invocationState: { requestId: "request-2" } },
    );

    expectCompletedRun(resumed);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ requestId: "request-2" });
  });

  it("strips the run's own keys from a RAW payload", async () => {
    // The TS SDK does not merge invocation state into event payloads, so this
    // event is built to look as if it had. Python's sanitizer strips the same
    // keys for the same reason.
    const { agent } = capturingAgent([
      {
        type: "modelRedactionEvent",
        outputRedaction: { text: "[redacted]" },
        authToken: "server-secret",
      },
    ]);

    const events = await runWith(agent, minimalRunInput(), {
      invocationState: { authToken: "server-secret" },
    });

    const raws = events.filter((e) => e.type === EventType.RAW) as Array<
      BaseEvent & { event: Record<string, unknown> }
    >;
    expect(raws).toHaveLength(1);
    expect(raws[0]!.event).toEqual({
      type: "modelRedactionEvent",
      outputRedaction: { text: "[redacted]" },
    });
  });
});

describe("invocationState on the orchestrator path", () => {
  function recordingOrchestrator() {
    const calls: unknown[][] = [];
    return {
      calls,
      orchestrator: {
        id: "graph",
        // No `model`, which is what routes the adapter to this path.
        // eslint-disable-next-line require-yield
        async *stream(...args: unknown[]) {
          calls.push(args);
        },
      },
    };
  }

  it("is forwarded to the orchestrator's stream() as a copy", async () => {
    const { orchestrator, calls } = recordingOrchestrator();
    const agent = new StrandsAgent({ agent: orchestrator as never, name: "o" });
    const invocationState = { tenantId: "tenant-1" };

    expectCompletedRun(
      await runWith(agent, minimalRunInput(), { invocationState }),
    );

    expect(calls).toHaveLength(1);
    const options = calls[0]![1] as { invocationState: InvocationState };
    expect(options.invocationState).toEqual(invocationState);
    expect(options.invocationState).not.toBe(invocationState);
  });

  it("omitted, keeps the single-argument call", async () => {
    const { orchestrator, calls } = recordingOrchestrator();
    const agent = new StrandsAgent({ agent: orchestrator as never, name: "o" });

    expectCompletedRun(await collect(agent));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it("reaches a node agent's hooks inside a real Graph", async () => {
    const { plugin, seen } = stateReadingPlugin();
    const node = new Agent({
      id: "writer",
      model: new ScriptedModel([modelTurn.text("done")]),
      plugins: [plugin],
      printer: false,
    });
    const graph = new Graph({ nodes: [node], edges: [], maxSteps: 1 });
    const agent = new StrandsAgent({ agent: graph as never, name: "g" });

    expectCompletedRun(
      await runWith(agent, USER_TURN, {
        invocationState: { requestId: "graph-request" },
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ requestId: "graph-request" });
  });
});

/** Agent that records what each `run()` was given, without running anything. */
class RecordingAgent extends FixedAgent {
  readonly received: Array<{ input: RunAgentInput; args: number }> = [];
  readonly invocationStates: Array<InvocationState | undefined> = [];

  async *run(
    input: RunAgentInput,
    ...rest: [StrandsAgentRunOptions?]
  ): AsyncGenerator<BaseEvent, void, void> {
    this.received.push({ input, args: 1 + rest.length });
    this.invocationStates.push(rest[0]?.invocationState);
    yield* super.run(input);
  }
}

async function startEndpoint(
  agent: StrandsAgent,
  options: Partial<Parameters<typeof addStrandsExpressEndpoint>[2]> = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  addStrandsExpressEndpoint(app, agent, {
    path: "/",
    bodyParser: express.json(),
    ...options,
  });
  const server = await listen(app);
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closeServer(server),
  };
}

describe("invocationStateProvider on the Express transport", () => {
  it("is called per request with the request and the validated input", async () => {
    const agent = new RecordingAgent();
    const seen: Array<[string | undefined, string]> = [];
    const { port, close } = await startEndpoint(agent, {
      invocationStateProvider: async (req, inputData) => {
        seen.push([req.header("x-tenant"), inputData.threadId]);
        return { tenantId: req.header("x-tenant") };
      },
    });
    try {
      // snake_case on the wire, so the provider is shown to get the
      // normalized, validated input rather than the raw body.
      const body = JSON.stringify({
        ...JSON.parse(runAgentInputPayload()),
        threadId: undefined,
        thread_id: "thread-from-body",
      });
      const first = await postRaw(port, body, {
        headers: { "x-tenant": "tenant-a" },
      });
      const second = await postRaw(port, body, {
        headers: { "x-tenant": "tenant-b" },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(seen).toEqual([
        ["tenant-a", "thread-from-body"],
        ["tenant-b", "thread-from-body"],
      ]);
      expect(agent.invocationStates).toEqual([
        { tenantId: "tenant-a" },
        { tenantId: "tenant-b" },
      ]);
    } finally {
      await close();
    }
  });

  it("omitted, calls run() with the input alone", async () => {
    const agent = new RecordingAgent();
    const { port, close } = await startEndpoint(agent);
    try {
      expect((await postRaw(port, runAgentInputPayload())).status).toBe(200);
      expect(agent.received.map((r) => r.args)).toEqual([1]);
    } finally {
      await close();
    }
  });

  it("returning nothing runs the agent with no invocation state", async () => {
    const agent = new RecordingAgent();
    const { port, close } = await startEndpoint(agent, {
      invocationStateProvider: () => undefined,
    });
    try {
      expect((await postRaw(port, runAgentInputPayload())).status).toBe(200);
      expect(agent.received.map((r) => r.args)).toEqual([1]);
    } finally {
      await close();
    }
  });

  it("is forwarded by createStrandsApp, synchronous provider included", async () => {
    const agent = new RecordingAgent();
    const app = await createStrandsApp(agent, {
      invocationStateProvider: (req, inputData) => ({
        requestId: `${req.method}:${inputData.runId}`,
      }),
    });
    const server = await listen(app);
    try {
      const { port } = server.address() as AddressInfo;
      expect((await postRaw(port, runAgentInputPayload())).status).toBe(200);
      expect(agent.invocationStates).toEqual([{ requestId: "POST:r" }]);
    } finally {
      await closeServer(server);
    }
  });

  it("is not called for a request auth rejects", async () => {
    const agent = new RecordingAgent();
    const provider = vi.fn(() => ({ tenantId: "t" }));
    const { port, close } = await startEndpoint(agent, {
      auth: (_req, res) => {
        res.status(401).json({ error: "Unauthorized" });
      },
      invocationStateProvider: provider,
    });
    try {
      expect((await postRaw(port, runAgentInputPayload())).status).toBe(401);
      expect(provider).not.toHaveBeenCalled();
      expect(agent.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("fails the request loudly when the result is not an object", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const agent = new RecordingAgent();
    (agent as unknown as { config: { logger: unknown } }).config.logger =
      logger;
    const { port, close } = await startEndpoint(agent, {
      invocationStateProvider: () => "not-an-object" as never,
    });
    try {
      const res = await postRaw(port, runAgentInputPayload());
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: "Internal Server Error" });
      expect(agent.runs).toBe(0);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(String(logger.error.mock.calls[0]![1])).toContain(
        "must return an object",
      );
    } finally {
      await close();
    }
  });

  it("answers a provider's own HTTP error status without its message", async () => {
    const agent = new RecordingAgent();
    (agent as unknown as { config: { logger: unknown } }).config.logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { port, close } = await startEndpoint(agent, {
      invocationStateProvider: async () => {
        throw Object.assign(new Error("tenant lookup at db-internal failed"), {
          status: 403,
        });
      },
    });
    try {
      const res = await postRaw(port, runAgentInputPayload());
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "Forbidden" });
      expect(res.body).not.toContain("db-internal");
      expect(agent.runs).toBe(0);
    } finally {
      await close();
    }
  });

  it("refuses a provider that is not a function on both entry points", async () => {
    const agent = new RecordingAgent();
    expect(() =>
      addStrandsExpressEndpoint(express(), agent, {
        path: "/",
        invocationStateProvider: { tenantId: "t" } as never,
      }),
    ).toThrow(/`invocationStateProvider` must be a function or undefined/);
    await expect(
      createStrandsApp(agent, {
        invocationStateProvider: "provider" as never,
      }),
    ).rejects.toThrow(
      /`invocationStateProvider` must be a function or undefined/,
    );
  });
});
