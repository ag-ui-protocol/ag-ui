import { describe, expect, it, vi } from "vitest";
import { MastraAgent } from "../mastra";
import {
  FakeLocalAgent,
  FakeRemoteAgent,
  collectEvents,
  makeInput,
} from "./helpers";
import { getLocalAgent, getLocalAgents } from "../utils";

const finishChunks = [{ type: "finish", payload: {} }];

describe("local Mastra stream hooks", () => {
  it("forwards Mastra prepareStep and lifecycle hooks", async () => {
    const prepareStep = vi.fn();
    const onFinish = vi.fn();
    const onStepFinish = vi.fn();
    const fake = new FakeLocalAgent({ streamChunks: finishChunks });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      prepareStep,
      onFinish,
      onStepFinish,
    });

    await collectEvents(agent, makeInput());

    expect(fake.lastStreamOpts?.prepareStep).toBe(prepareStep);
    expect(fake.lastStreamOpts?.onFinish).toBe(onFinish);
    expect(fake.lastStreamOpts?.onStepFinish).toBe(onStepFinish);
  });

  it("does not forward in-process callbacks to remote agents", async () => {
    const fake = new FakeRemoteAgent({ streamChunks: finishChunks });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      prepareStep: vi.fn(),
      onFinish: vi.fn(),
      onStepFinish: vi.fn(),
    });

    await collectEvents(agent, makeInput());

    expect(fake.lastStreamOpts).not.toHaveProperty("prepareStep");
    expect(fake.lastStreamOpts).not.toHaveProperty("onFinish");
    expect(fake.lastStreamOpts).not.toHaveProperty("onStepFinish");
  });

  it("getLocalAgent exposes and forwards the hooks", async () => {
    const prepareStep = vi.fn();
    const onFinish = vi.fn();
    const onStepFinish = vi.fn();
    const fake = new FakeLocalAgent({ streamChunks: finishChunks });
    const mastra = { getAgent: vi.fn(() => fake) } as any;
    const agent = getLocalAgent({
      mastra,
      agentId: "test-agent",
      resourceId: "resource-1",
      prepareStep,
      onFinish,
      onStepFinish,
    }) as MastraAgent;

    await collectEvents(agent, makeInput());

    expect(fake.lastStreamOpts?.prepareStep).toBe(prepareStep);
    expect(fake.lastStreamOpts?.onFinish).toBe(onFinish);
    expect(fake.lastStreamOpts?.onStepFinish).toBe(onStepFinish);
  });

  it("getLocalAgents exposes and forwards the hooks to each agent", async () => {
    const prepareStep = vi.fn();
    const onFinish = vi.fn();
    const onStepFinish = vi.fn();
    const first = new FakeLocalAgent({ streamChunks: finishChunks });
    const second = new FakeLocalAgent({ streamChunks: finishChunks });
    const mastra = {
      listAgents: vi.fn(() => ({ first, second })),
    } as any;
    const agents = getLocalAgents({
      mastra,
      resourceId: "resource-1",
      prepareStep,
      onFinish,
      onStepFinish,
    });

    await collectEvents(agents.first as MastraAgent, makeInput());
    await collectEvents(agents.second as MastraAgent, makeInput());

    for (const fake of [first, second]) {
      expect(fake.lastStreamOpts?.prepareStep).toBe(prepareStep);
      expect(fake.lastStreamOpts?.onFinish).toBe(onFinish);
      expect(fake.lastStreamOpts?.onStepFinish).toBe(onStepFinish);
    }
  });
});
