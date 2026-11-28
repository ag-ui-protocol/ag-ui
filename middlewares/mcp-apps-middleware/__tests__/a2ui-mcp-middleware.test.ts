import { basicCatalog } from "@a2ui/web_core/v1_0";
import type { ActivitySnapshotEvent, BaseEvent } from "@ag-ui/client";
import { MCPAppsMiddleware, type MCPClientConfig } from "../src/index";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  A2UI_ACTIVITY_TYPE,
  type A2uiAction,
  type A2uiMcpOrigin,
  A2uiMcpMiddleware,
  type A2uiMcpMiddlewareConfig,
} from "../src/a2ui";
import {
  actionCalls,
  BASIC_CATALOG_ID,
  customer,
  customerComponents,
  createFixtureServer,
  resourceReads,
} from "./a2ui/fixtures";
import {
  activitySnapshots,
  MiddlewareAgent,
  runInput,
  runScripted,
  ScriptedAgent,
  runWithMiddlewares,
  type ScriptedRun,
  type ScriptedToolCall,
  toolCallResults,
} from "./a2ui/scripted-agent";
import { startTestMcpServer, type TestMcpServer } from "./a2ui/test-mcp-server";

describe("A2uiMcpMiddleware", () => {
  let mcpServer: TestMcpServer;
  let mcpServers: MCPClientConfig[];

  beforeAll(async () => {
    mcpServer = await startTestMcpServer(() =>
      createFixtureServer({ withActions: true }),
    );
    mcpServers = [{ type: "http", url: mcpServer.url, serverId: "test" }];
  });

  afterAll(async () => {
    await mcpServer.close();
  });

  beforeEach(() => {
    resourceReads.clear();
    actionCalls.length = 0;
  });

  function run(
    a2uiMcp: A2uiMcpMiddleware,
    toolCalls: ScriptedToolCall[],
  ): Promise<BaseEvent[]> {
    const mcpApps = new MCPAppsMiddleware({ mcpServers });
    return runWithMiddlewares([a2uiMcp, mcpApps], toolCalls);
  }

  function runOnce(
    toolCalls: ScriptedToolCall[],
    config?: A2uiMcpMiddlewareConfig,
  ): Promise<BaseEvent[]> {
    const a2uiMcp = new A2uiMcpMiddleware(config);
    return run(a2uiMcp, toolCalls);
  }

  function runWithoutA2uiMcp(toolCalls: ScriptedToolCall[]) {
    const mcpApps = new MCPAppsMiddleware({ mcpServers });
    return runWithMiddlewares([mcpApps], toolCalls);
  }

  function shape(events: BaseEvent[]) {
    return events.map((event) => {
      const snapshot = event as ActivitySnapshotEvent;
      return [event.type, snapshot.activityType ?? null];
    });
  }

  function a2uiContent(snapshot: ActivitySnapshotEvent) {
    return snapshot.content as {
      a2ui_operations: Record<string, Record<string, unknown>>[];
      error?: string;
      mcp?: A2uiMcpOrigin;
    };
  }

  async function renderCustomer(
    a2uiMcp: A2uiMcpMiddleware,
    servers = mcpServers,
  ): Promise<A2uiMcpOrigin> {
    const mcpApps = new MCPAppsMiddleware({ mcpServers: servers });
    const toolCalls = [{ name: "getCustomer", args: { id: "c1" } }];
    const events = await runWithMiddlewares([a2uiMcp, mcpApps], toolCalls);
    const snapshot = activitySnapshots(events)[0];
    const origin = a2uiContent(snapshot).mcp;
    if (!origin) {
      throw new Error("The snapshot has no MCP origin.");
    }
    return origin;
  }

  function customerAction(name: string, origin: A2uiMcpOrigin): A2uiAction {
    return {
      userAction: {
        name,
        surfaceId: `customer-details-${origin.presentationId}`,
        sourceComponentId: "reload",
        timestamp: "2026-11-15T12:00:00.000Z",
        context: { id: "c9" },
      },
      mcp: origin,
    };
  }

  function runAction(
    a2uiMcp: A2uiMcpMiddleware,
    a2uiAction: A2uiAction,
    servers = mcpServers,
  ): Promise<ScriptedRun> {
    const mcpApps = new MCPAppsMiddleware({ mcpServers: servers });
    return runScripted([a2uiMcp, mcpApps], [], { a2uiAction });
  }

  it("leaves tools without A2UI metadata unchanged", async () => {
    const toolCalls = [{ name: "getWeather", args: { id: "graz" } }];

    const withMiddleware = await runOnce(toolCalls);
    const withoutMiddleware = await runWithoutA2uiMcp(toolCalls);

    expect(shape(withMiddleware)).toEqual(shape(withoutMiddleware));
    expect(activitySnapshots(withMiddleware)).toHaveLength(0);
    expect(toolCallResults(withMiddleware)[0].content).toBe("Sunny.");
  });

  it("leaves HTML-based MCP Apps unchanged", async () => {
    const toolCalls = [{ name: "showWidget", args: { id: "w" } }];

    const withMiddleware = await runOnce(toolCalls);
    const withoutMiddleware = await runWithoutA2uiMcp(toolCalls);

    const snapshots = activitySnapshots(withMiddleware);
    const expected = activitySnapshots(withoutMiddleware);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].activityType).toBe("mcp-apps");
    expect(snapshots[0].content).toEqual(expected[0].content);
    expect(resourceReads.get("ui://widget")).toBeUndefined();
  });

  it("renders a structured tool result as one A2UI surface", async () => {
    const events = await runOnce([{ name: "getCustomer", args: { id: "c1" } }]);

    const snapshots = activitySnapshots(events);
    const toolCallId = toolCallResults(events)[0].toolCallId;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      messageId: `a2ui-surface-${toolCallId}`,
      activityType: A2UI_ACTIVITY_TYPE,
      replace: true,
    });
    expect(a2uiContent(snapshots[0])).toEqual({
      a2ui_operations: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: `customer-details-${toolCallId}`,
            catalogId: BASIC_CATALOG_ID,
            components: customerComponents,
            dataModel: { customer: customer("c1") },
          },
        },
      ],
      mcp: {
        serverHash: expect.any(String),
        serverId: "test",
        resourceUri: "a2ui://customer-details",
        presentationId: toolCallId,
      },
    });
  });

  it("keeps the tool result for the model untouched", async () => {
    const toolCalls = [{ name: "getCustomer", args: { id: "c1" } }];

    const withMiddleware = await runOnce(toolCalls);
    const withoutMiddleware = await runWithoutA2uiMcp(toolCalls);

    const results = toolCallResults(withMiddleware);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe(
      toolCallResults(withoutMiddleware)[0].content,
    );
  });

  it("prefers the resource URI of the tool result", async () => {
    const events = await runOnce([
      { name: "getCustomerCompact", args: { id: "c2" } },
    ]);

    const operations = a2uiContent(
      activitySnapshots(events)[0],
    ).a2ui_operations;
    const surface = operations[0]["createSurface"];
    expect(surface["surfaceId"]).toMatch(/^customer-compact-/);
    expect(resourceReads.get("a2ui://customer-compact")).toBe(1);
    expect(resourceReads.get("a2ui://customer-details")).toBeUndefined();
  });

  it("reuses updateDataModel operations from the tool result", async () => {
    const events = await runOnce([
      { name: "getCustomerOps", args: { id: "c3" } },
    ]);

    const toolCallId = toolCallResults(events)[0].toolCallId;
    const operations = a2uiContent(
      activitySnapshots(events)[0],
    ).a2ui_operations;
    expect(operations).toHaveLength(2);
    expect(operations[0]["createSurface"]["dataModel"]).toBeUndefined();
    expect(operations[1]).toEqual({
      version: "1.0",
      updateDataModel: {
        surfaceId: `customer-details-${toolCallId}`,
        path: "/customer",
        value: customer("c3"),
      },
    });
  });

  it("creates distinct surfaces for repeated calls with different results", async () => {
    const a2uiMcp = new A2uiMcpMiddleware();

    const first = await run(a2uiMcp, [
      { name: "getCustomer", args: { id: "a" } },
    ]);
    const second = await run(a2uiMcp, [
      { name: "getCustomer", args: { id: "b" } },
    ]);

    const firstSurface = a2uiContent(activitySnapshots(first)[0])
      .a2ui_operations[0]["createSurface"];
    const secondSurface = a2uiContent(activitySnapshots(second)[0])
      .a2ui_operations[0]["createSurface"];
    expect(firstSurface["surfaceId"]).not.toBe(secondSurface["surfaceId"]);
    expect(firstSurface["dataModel"]).toEqual({ customer: customer("a") });
    expect(secondSurface["dataModel"]).toEqual({ customer: customer("b") });
    expect(resourceReads.get("a2ui://customer-details")).toBe(1);
  });

  it("renders several A2UI tool calls of one run without duplicates", async () => {
    const events = await runOnce([
      { name: "getCustomer", args: { id: "x" } },
      { name: "getCustomer", args: { id: "y" } },
    ]);

    const snapshots = activitySnapshots(events);
    const messageIds = snapshots.map((snapshot) => snapshot.messageId);
    const toolCallIds = toolCallResults(events).map(
      (result) => `a2ui-surface-${result.toolCallId}`,
    );
    expect(snapshots).toHaveLength(2);
    expect(messageIds).toEqual(toolCallIds);
    expect(
      snapshots.every(
        (snapshot) => snapshot.activityType === A2UI_ACTIVITY_TYPE,
      ),
    ).toBe(true);
  });

  it("shares one resource read between concurrent calls", async () => {
    const a2uiMcp = new A2uiMcpMiddleware();

    await Promise.all([
      run(a2uiMcp, [{ name: "getCustomer", args: { id: "p" } }]),
      run(a2uiMcp, [{ name: "getCustomer", args: { id: "q" } }]),
    ]);

    expect(resourceReads.get("a2ui://customer-details")).toBe(1);
  });

  it("reloads templates once the cache entry expired", async () => {
    const a2uiMcp = new A2uiMcpMiddleware({ templateCacheTtlMs: 0 });

    await run(a2uiMcp, [{ name: "getCustomer", args: { id: "r" } }]);
    await run(a2uiMcp, [{ name: "getCustomer", args: { id: "s" } }]);

    expect(resourceReads.get("a2ui://customer-details")).toBe(2);
  });

  it("reports invalid JSON resources as an error surface", async () => {
    const events = await runOnce([{ name: "getBroken", args: { id: "b" } }]);

    const snapshots = activitySnapshots(events);
    expect(snapshots).toHaveLength(1);
    expect(a2uiContent(snapshots[0])).toEqual({
      a2ui_operations: [],
      error: "A2UI payload is not valid JSON.",
    });
    expect(toolCallResults(events)).toHaveLength(1);
  });

  it("reports templates that exceed the size limit", async () => {
    const events = await runOnce([{ name: "getCustomer", args: { id: "z" } }], {
      maxPayloadBytes: 10,
    });

    expect(a2uiContent(activitySnapshots(events)[0])).toEqual({
      a2ui_operations: [],
      error: "A2UI payload exceeds the limit of 10 bytes.",
    });
  });

  it("reports components missing in the configured catalogs", async () => {
    const events = await runOnce(
      [{ name: "getUnknownComponent", args: { id: "u" } }],
      { catalogs: [basicCatalog] },
    );

    const content = a2uiContent(activitySnapshots(events)[0]);
    expect(content.a2ui_operations).toEqual([]);
    expect(content.error).toContain("Unknown component type 'Bogus'");
  });

  it("skips the catalog check without configured catalogs", async () => {
    const events = await runOnce([
      { name: "getUnknownComponent", args: { id: "u" } },
    ]);

    const content = a2uiContent(activitySnapshots(events)[0]);
    expect(content.error).toBeUndefined();
    expect(content.a2ui_operations).toHaveLength(1);
  });

  it("reports unavailable resources and retries them later", async () => {
    const a2uiMcp = new A2uiMcpMiddleware();

    const failed = await run(a2uiMcp, [
      { name: "getFlaky", args: { id: "f" } },
    ]);
    const recovered = await run(a2uiMcp, [
      { name: "getFlaky", args: { id: "f" } },
    ]);

    expect(a2uiContent(activitySnapshots(failed)[0]).error).toBe(
      "The A2UI resource a2ui://flaky could not be read.",
    );
    expect(
      a2uiContent(activitySnapshots(recovered)[0]).a2ui_operations,
    ).toHaveLength(1);
    expect(resourceReads.get("a2ui://flaky")).toBe(2);
  });

  it("reports failed tool results as an error surface", async () => {
    const events = await runOnce([{ name: "getFailing", args: { id: "e" } }]);

    expect(a2uiContent(activitySnapshots(events)[0])).toEqual({
      a2ui_operations: [],
      error: "The MCP tool reported an error.",
    });
  });

  it("passes resources with another MIME type through", async () => {
    const events = await runOnce([{ name: "getPlain", args: { id: "p" } }]);

    const snapshots = activitySnapshots(events);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].activityType).toBe("mcp-apps");
  });

  it("passes actions on to the agent by default", async () => {
    const a2uiMcp = new A2uiMcpMiddleware();
    const origin = await renderCustomer(a2uiMcp);
    const action = customerAction("reloadCustomer", origin);

    const run = await runAction(a2uiMcp, action);

    const toolNames = run.agentInputs[0].tools.map((tool) => tool.name);
    expect(run.agentInputs).toHaveLength(1);
    expect(run.agentInputs[0].forwardedProps).toEqual({ a2uiAction: action });
    expect(toolNames).not.toContain("a2ui_action");
    expect(actionCalls).toHaveLength(0);
  });

  it("routes actions to a2ui_action with the template surface ID", async () => {
    const a2uiMcp = new A2uiMcpMiddleware({ actions: "mcp" });
    const origin = await renderCustomer(a2uiMcp);
    const action = customerAction("reloadCustomer", origin);

    const run = await runAction(a2uiMcp, action);

    expect(run.agentInputs).toHaveLength(0);
    expect(actionCalls).toEqual([
      {
        name: "reloadCustomer",
        surfaceId: "customer-details",
        sourceComponentId: "reload",
        timestamp: "2026-11-15T12:00:00.000Z",
        context: { id: "c9" },
      },
    ]);
  });

  it("appends the renamed operations of a2ui_action to the activity", async () => {
    const a2uiMcp = new A2uiMcpMiddleware({
      actions: "mcp",
      catalogs: [basicCatalog],
    });
    const origin = await renderCustomer(a2uiMcp);
    const action = customerAction("reloadCustomer", origin);

    const run = await runAction(a2uiMcp, action);

    const presentationId = origin.presentationId;
    expect(run.events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "ACTIVITY_DELTA",
      "RUN_FINISHED",
    ]);
    expect(run.events[1]).toEqual({
      type: "ACTIVITY_DELTA",
      messageId: `a2ui-surface-${presentationId}`,
      activityType: A2UI_ACTIVITY_TYPE,
      patch: [
        {
          op: "add",
          path: "/a2ui_operations/-",
          value: {
            version: "1.0",
            updateDataModel: {
              surfaceId: `customer-details-${presentationId}`,
              path: "/customer",
              value: customer("c9"),
            },
          },
        },
      ],
    });
  });

  it("falls back to the agent without a2ui_action", async () => {
    const plainServer = await startTestMcpServer(() => createFixtureServer());
    try {
      const servers: MCPClientConfig[] = [
        { type: "http", url: plainServer.url, serverId: "test" },
      ];
      const a2uiMcp = new A2uiMcpMiddleware({ actions: "mcp" });
      const origin = await renderCustomer(a2uiMcp, servers);
      const action = customerAction("reloadCustomer", origin);

      const run = await runAction(a2uiMcp, action, servers);

      expect(run.agentInputs).toHaveLength(1);
      expect(run.agentInputs[0].forwardedProps).toEqual({ a2uiAction: action });
    } finally {
      await plainServer.close();
    }
  });

  it("falls back to the agent for actions a2ui_action rejects", async () => {
    const a2uiMcp = new A2uiMcpMiddleware({ actions: "mcp" });
    const origin = await renderCustomer(a2uiMcp);

    const run = await runAction(a2uiMcp, customerAction("unknown", origin));

    expect(actionCalls).toHaveLength(1);
    expect(run.agentInputs).toHaveLength(1);
  });

  it("reports action results above the size limit without passing the action on", async () => {
    const a2uiMcp = new A2uiMcpMiddleware({
      actions: "mcp",
      maxPayloadBytes: 2048,
    });
    const origin = await renderCustomer(a2uiMcp);

    const run = await runAction(a2uiMcp, customerAction("oversized", origin));

    expect(actionCalls).toHaveLength(1);
    expect(run.agentInputs).toHaveLength(0);
    expect(run.events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "ACTIVITY_DELTA",
      "RUN_FINISHED",
    ]);
    expect(run.events[1]).toMatchObject({
      messageId: `a2ui-surface-${origin.presentationId}`,
      patch: [
        {
          op: "add",
          path: "/error",
          value: "A2UI payload exceeds the limit of 2048 bytes.",
        },
      ],
    });
  });

  it("reports invalid action results without passing the action on", async () => {
    const a2uiMcp = new A2uiMcpMiddleware({
      actions: "mcp",
      catalogs: [basicCatalog],
    });
    const origin = await renderCustomer(a2uiMcp);

    const run = await runAction(a2uiMcp, customerAction("addBogus", origin));

    const patch = (
      run.events[1] as { patch: { path: string; value: string }[] }
    ).patch;
    expect(actionCalls).toHaveLength(1);
    expect(run.agentInputs).toHaveLength(0);
    expect(patch).toHaveLength(1);
    expect(patch[0].path).toBe("/error");
    expect(patch[0].value).toContain("Unknown component type 'Bogus'");
  });

  it("accepts action results that reference components of earlier actions", async () => {
    const a2uiMcp = new A2uiMcpMiddleware({
      actions: "mcp",
      catalogs: [basicCatalog],
    });
    const origin = await renderCustomer(a2uiMcp);

    const run = await runAction(a2uiMcp, customerAction("linkPanel", origin));

    expect(run.agentInputs).toHaveLength(0);
    expect(run.events[1]).toMatchObject({
      type: "ACTIVITY_DELTA",
      patch: [
        {
          op: "add",
          path: "/a2ui_operations/-",
          value: {
            version: "1.0",
            updateComponents: {
              surfaceId: `customer-details-${origin.presentationId}`,
              components: [{ id: "root", component: "Card", child: "panel" }],
            },
          },
        },
      ],
    });
  });

  it("does not call a2ui_action once the run is cancelled", async () => {
    const origin = await renderCustomer(
      new A2uiMcpMiddleware({ actions: "mcp" }),
    );
    const a2uiMcp = new A2uiMcpMiddleware({ actions: "mcp" });
    const mcpApps = new MCPAppsMiddleware({ mcpServers });
    const next = new MiddlewareAgent(mcpApps, new ScriptedAgent([]));
    const a2uiAction = customerAction("reloadCustomer", origin);

    const subscription = a2uiMcp
      .run(runInput({ a2uiAction }), next)
      .subscribe();
    subscription.unsubscribe();

    await vi.waitFor(() => {
      expect(resourceReads.get("a2ui://customer-details")).toBe(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(actionCalls).toHaveLength(0);
  });
});
