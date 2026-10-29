import { expect, test } from "vitest";
import { SequenceAgent, toolTurn } from "./sequence-agent";
import {
  type ActivitySnapshotEvent,
  EventType,
  type ToolCallResultEvent,
} from "@ag-ui/client";
import { MCPAppsMiddleware, getServerHash } from "../src/index";
import {
  MockAgent,
  collectEvents,
  createRunAgentInput,
  createRunStartedEvent,
  createRunFinishedEvent,
} from "./test-utils";

// Opt in: this contacts the public server. It verifies real discovery/execution,
// not model choice or browser rendering (covered by downstream app validation).
test.runIf(process.env.MCP_APPS_LIVE_TEST === "1")(
  "public Excalidraw exposes read_me, executes create_view, and serves its UI",
  async () => {
    const server = {
      type: "http" as const,
      url: "https://mcp.excalidraw.com/mcp",
      serverId: "excalidraw",
    };
    const middleware = new MCPAppsMiddleware({
      mcpServers: [server],
      discoveryFailureMode: "throw",
    });
    const agent = new MockAgent([
      createRunStartedEvent(),
      createRunFinishedEvent(),
    ]);
    await collectEvents(middleware.run(createRunAgentInput(), agent));
    const names = agent.runCalls[0].tools.map((tool) => tool.name);
    expect(names).toContain("read_me");
    expect(names).toContain("create_view");
    for (const name of [
      "export_to_excalidraw",
      "save_checkpoint",
      "read_checkpoint",
    ]) {
      expect(names).not.toContain(name);
    }

    const elements = JSON.stringify([
      {
        type: "rectangle",
        id: "pni-583",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        label: { text: "MCP prerequisite available" },
      },
    ]);
    const sequence = new SequenceAgent((input, turn) => {
      if (turn === 0) return toolTurn(input, "read_me", "guide");
      expect(input.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          toolCallId: "guide",
          content: expect.stringContaining("rectangle"),
        }),
      );
      return toolTurn(
        input,
        "create_view",
        "view",
        JSON.stringify({ elements }),
      );
    });
    const second = await collectEvents(
      middleware.run(createRunAgentInput(), sequence),
    );
    expect(sequence.runCalls).toHaveLength(2);
    const results = second.filter(
      (event): event is ToolCallResultEvent =>
        event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain("rectangle");
    expect(
      second.filter((event) => event.type === EventType.ACTIVITY_SNAPSHOT),
    ).toHaveLength(1);
    expect(
      second.filter((event) => event.type === EventType.RUN_STARTED),
    ).toHaveLength(1);
    expect(
      second.filter((event) => event.type === EventType.RUN_FINISHED),
    ).toHaveLength(1);
    const activity = second.find(
      (event): event is ActivitySnapshotEvent =>
        event.type === EventType.ACTIVITY_SNAPSHOT,
    );
    if (!activity) throw new Error("Missing diagram activity");
    expect(activity.content.resourceUri).toBe("ui://excalidraw/mcp-app.html");
    expect(activity.content.result).not.toHaveProperty("isError", true);
    expect(activity.content.toolInput).toEqual({ elements });
    expect(
      second.some((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toBe(true);

    const resource = await collectEvents(
      middleware.run(
        createRunAgentInput({
          forwardedProps: {
            __proxiedMCPRequest: {
              serverHash: getServerHash(server),
              serverId: server.serverId,
              method: "resources/read",
              params: { uri: activity.content.resourceUri },
            },
          },
        }),
        agent,
      ),
    );
    expect(resource.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      result: {
        contents: expect.arrayContaining([
          expect.objectContaining({
            mimeType: "text/html;profile=mcp-app",
            text: expect.stringContaining("<html"),
          }),
        ]),
      },
    });
  },
  60_000,
);
