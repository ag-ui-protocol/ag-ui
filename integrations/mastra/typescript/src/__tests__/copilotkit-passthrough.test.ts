import { describe, it, expect, vi, beforeEach } from "vitest";

const { CopilotRuntimeSpy, copilotRuntimeNodeHttpEndpointSpy } = vi.hoisted(
  () => ({
    CopilotRuntimeSpy: vi.fn(),
    copilotRuntimeNodeHttpEndpointSpy: vi.fn(),
  }),
);

vi.mock("@copilotkit/runtime", () => ({
  CopilotRuntime: CopilotRuntimeSpy,
  copilotRuntimeNodeHttpEndpoint: copilotRuntimeNodeHttpEndpointSpy,
  ExperimentalEmptyAdapter: class ExperimentalEmptyAdapter {},
}));

vi.mock("@mastra/core/server", () => ({
  registerApiRoute: vi.fn((path: string, opts: any) => ({ path, ...opts })),
}));

import { registerCopilotKit } from "../copilotkit";

describe("registerCopilotKit forwards CopilotRuntime options", () => {
  beforeEach(() => {
    CopilotRuntimeSpy.mockReset();
    CopilotRuntimeSpy.mockImplementation(function (this: any) {});
    copilotRuntimeNodeHttpEndpointSpy.mockReset();
    copilotRuntimeNodeHttpEndpointSpy.mockImplementation(
      () => async () => new Response("ok"),
    );
  });

  async function invokeRoute(
    overrides: Partial<Parameters<typeof registerCopilotKit>[0]> = {},
  ) {
    const route = registerCopilotKit({
      path: "/api/copilotkit",
      resourceId: "test-resource",
      agents: {},
      ...overrides,
    }) as any;

    const fakeContext = {
      get: () => ({}),
      req: { raw: new Request("http://localhost/api/copilotkit") },
    };
    await route.handler(fakeContext);
    return CopilotRuntimeSpy.mock.calls[0][0];
  }

  it("forwards a2ui, mcpApps, and openGenerativeUI when supplied", async () => {
    const a2ui = { injectA2UITool: true } as any;
    const mcpApps = { calculator: { url: "http://example.com/mcp" } } as any;
    const openGenerativeUI = { enabled: true } as any;

    const constructorArgs = await invokeRoute({
      a2ui,
      mcpApps,
      openGenerativeUI,
    });

    expect(CopilotRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(constructorArgs.a2ui).toBe(a2ui);
    expect(constructorArgs.mcpApps).toBe(mcpApps);
    expect(constructorArgs.openGenerativeUI).toBe(openGenerativeUI);
  });

  it("passes undefined for each option when not supplied", async () => {
    const constructorArgs = await invokeRoute();

    expect(CopilotRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(constructorArgs.a2ui).toBeUndefined();
    expect(constructorArgs.mcpApps).toBeUndefined();
    expect(constructorArgs.openGenerativeUI).toBeUndefined();
  });
});
