import { describe, expect, it, vi } from "vitest";
import {
  EventType,
  PROTOCOL_VERSION,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/core";
import { LangGraphAgent } from "../agent";

/**
 * Every RUN_STARTED this integration emits declares the protocol version it
 * implements. There are three emission sites: the normal stream, the
 * outstanding-interrupt short circuit, and the synthesized RUN_STARTED that
 * precedes a RUN_ERROR when preparation fails before the stream starts.
 */

const input: RunAgentInput = {
  threadId: "thread-version",
  runId: "run-version",
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
  messages: [{ id: "u1", role: "user", content: "Hello" }],
};

type Scenario = "stream" | "outstanding-interrupt" | "prepare-failure";

function makeAgent(scenario: Scenario) {
  const agent = new LangGraphAgent({
    graphId: "test",
    deploymentUrl: "http://localhost:8000",
  });
  const tasks =
    scenario === "outstanding-interrupt"
      ? [{ interrupts: [{ value: { reason: "confirm" }, id: "int-1" }] }]
      : [];
  const client = {
    assistants: {
      search:
        scenario === "prepare-failure"
          ? vi.fn().mockRejectedValue(new Error("no assistants"))
          : vi
              .fn()
              .mockResolvedValue([
                { assistant_id: "asst", graph_id: "test", config: {} },
              ]),
      getGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
      getSchemas: vi.fn().mockResolvedValue({
        input_schema: { properties: { messages: {} } },
        output_schema: { properties: { messages: {} } },
      }),
    },
    threads: {
      get: vi.fn().mockResolvedValue({ thread_id: input.threadId }),
      getState: vi.fn().mockResolvedValue({
        values: { messages: [] },
        next: [],
        tasks,
        metadata: {},
      }),
      getHistory: vi.fn().mockResolvedValue([]),
    },
    runs: {
      stream: vi.fn().mockImplementation(async function* () {}),
    },
  };
  Object.assign(agent, { client });
  return { agent, client };
}

async function collect(agent: LangGraphAgent) {
  const events: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    agent.run(input).subscribe({
      next: (event) => events.push(event),
      error: reject,
      complete: resolve,
    }),
  );
  return events;
}

describe("RUN_STARTED protocolVersion", () => {
  it.each([
    ["stream", true],
    ["outstanding-interrupt", false],
    ["prepare-failure", false],
  ] as const)("is declared on RUN_STARTED (%s)", async (scenario, streams) => {
    const { agent, client } = makeAgent(scenario);
    const events = await collect(agent);
    const started = events.filter((e) => e.type === EventType.RUN_STARTED);
    expect(started).toHaveLength(1);
    expect(events[0]).toBe(started[0]);
    expect(started[0]).toMatchObject({
      threadId: input.threadId,
      protocolVersion: PROTOCOL_VERSION,
    });
    // Pins which emission site each scenario exercised.
    expect(client.runs.stream).toHaveBeenCalledTimes(streams ? 1 : 0);
  });
});
