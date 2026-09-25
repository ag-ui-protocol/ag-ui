import { describe, it, expect } from "vitest";
import type { AgentCapabilities } from "@ag-ui/client";
import { FakeLocalAgent } from "./helpers";
import { MastraAgent } from "../mastra";
import { getLocalAgents } from "../utils";

function makeAgent(
  config: Partial<ConstructorParameters<typeof MastraAgent>[0]> = {},
) {
  return new MastraAgent({
    agentId: "test-agent",
    agent: new FakeLocalAgent({ streamChunks: [] }) as any,
    resourceId: "resource-1",
    ...config,
  });
}

describe("getCapabilities (inferred)", () => {
  it("advertises what the bridge itself implements", async () => {
    const capabilities = await makeAgent().getCapabilities();

    expect(capabilities).toEqual({
      transport: { streaming: true },
      tools: { supported: true, clientProvided: true },
      state: { snapshots: true, deltas: true },
      reasoning: { supported: true, streaming: true },
      humanInTheLoop: { supported: true, interrupts: true },
    });
  });

  it("reports interrupts off when emitInterruptOutcome is disabled", async () => {
    const capabilities = await makeAgent({
      emitInterruptOutcome: false,
    }).getCapabilities();

    expect(capabilities.humanInTheLoop).toEqual({
      supported: true,
      interrupts: false,
    });
  });
});

describe("getCapabilities (declared)", () => {
  it("adds categories the bridge cannot infer", async () => {
    const capabilities = await makeAgent({
      capabilities: {
        multimodal: { input: { pdf: true } },
        custom: { modes: ["assisted"] },
      },
    }).getCapabilities();

    expect(capabilities.multimodal).toEqual({ input: { pdf: true } });
    expect(capabilities.custom).toEqual({ modes: ["assisted"] });
    // Inferred categories survive alongside the declared ones.
    expect(capabilities.transport).toEqual({ streaming: true });
  });

  it("replaces an inferred category rather than deep-merging it", async () => {
    const capabilities = await makeAgent({
      capabilities: { tools: { supported: false } },
    }).getCapabilities();

    expect(capabilities.tools).toEqual({ supported: false });
  });

  it("resolves the thunk form on every call, so the answer stays current", async () => {
    let pdf = false;
    const agent = makeAgent({
      capabilities: (): AgentCapabilities => ({
        multimodal: { input: { pdf } },
      }),
    });

    expect((await agent.getCapabilities()).multimodal).toEqual({
      input: { pdf: false },
    });

    pdf = true;
    expect((await agent.getCapabilities()).multimodal).toEqual({
      input: { pdf: true },
    });
  });

  it("awaits an async thunk", async () => {
    const agent = makeAgent({
      capabilities: async () => ({ identity: { name: "resolved" } }),
    });

    expect((await agent.getCapabilities()).identity).toEqual({
      name: "resolved",
    });
  });

  it("survives clone(), which CopilotKit relies on", async () => {
    const agent = makeAgent({
      capabilities: { custom: { modes: ["assisted"] } },
    });

    const cloned = agent.clone() as MastraAgent;

    expect((await cloned.getCapabilities()).custom).toEqual({
      modes: ["assisted"],
    });
  });
});

describe("getLocalAgents forwards capabilities", () => {
  it("applies each agent's entry and leaves the rest inferred-only", async () => {
    const mastra = {
      listAgents: () => ({
        declared: new FakeLocalAgent({ streamChunks: [] }),
        undeclared: new FakeLocalAgent({ streamChunks: [] }),
      }),
    } as any;

    const agents = getLocalAgents({
      mastra,
      resourceId: "resource-1",
      capabilities: {
        declared: { multimodal: { input: { pdf: true } } },
      },
    });

    const declared = await (agents.declared as MastraAgent).getCapabilities();
    const undeclared = await (
      agents.undeclared as MastraAgent
    ).getCapabilities();

    expect(declared.multimodal).toEqual({ input: { pdf: true } });
    expect(undeclared.multimodal).toBeUndefined();
    expect(undeclared.transport).toEqual({ streaming: true });
  });
});
