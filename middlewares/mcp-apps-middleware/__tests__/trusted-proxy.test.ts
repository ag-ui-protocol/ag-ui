import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import { MCPAppsMiddleware, getServerHash } from "../src/index";
import {
  MockAgent,
  createRunAgentInput,
  createRunStartedEvent,
  createRunFinishedEvent,
  createToolCallStartEvent,
  createToolCallArgsEvent,
  createToolCallEndEvent,
} from "./test-utils";

/** Serve the MCP HTTP protocol and record transport effects on real sockets. */
async function setup(
  sharedEndpoint = false,
  stallDelete = false,
  redirect = false,
  rejectAuth = false,
  metadata: "legacy" | "nested" | "both" = "legacy",
  options: {
    visibility?: string[];
    initializationFailure?: "initialized-error" | "unsupported-version";
    rejectDelete?: boolean;
  } = {},
) {
  const requests: Array<{
    method: string;
    authorization?: string;
    rpc?: string;
    sessionId?: string;
  }> = [];
  let stalledDeleteClosed = false;
  const server = createServer(async (request, response) => {
    const entry = {
      method: request.method!,
      authorization: request.headers.authorization,
      sessionId: request.headers["mcp-session-id"]?.toString(),
      rpc: undefined as string | undefined,
    };
    requests.push(entry);
    if (rejectAuth) {
      response.writeHead(401).end("private-auth-diagnostic");
      return;
    }
    if (redirect && request.url !== "/capture") {
      response.writeHead(307, { location: "/capture" }).end();
      return;
    }
    if (request.method === "DELETE") {
      if (stallDelete) {
        response.on("close", () => {
          stalledDeleteClosed = true;
        });
        return;
      }
      if (options.rejectDelete) {
        response.writeHead(500).end("private-cleanup-diagnostic");
        return;
      }
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    entry.rpc = message.method;
    if (
      message.method === "notifications/initialized" &&
      options.initializationFailure === "initialized-error"
    ) {
      response.writeHead(500).end("private-initialization-diagnostic");
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion:
              options.initializationFailure === "unsupported-version"
                ? "2099-01-01"
                : message.params.protocolVersion,
            capabilities: { resources: {}, tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "card",
                  description: "Card",
                  inputSchema: { type: "object", properties: {} },
                  _meta:
                    metadata === "legacy"
                      ? { "ui/resourceUri": "ui://card" }
                      : {
                          ui: {
                            resourceUri: "ui://card",
                            ...(options.visibility
                              ? { visibility: options.visibility }
                              : {}),
                          },
                          ...(metadata === "both"
                            ? { "ui/resourceUri": "ui://legacy" }
                            : {}),
                        },
                },
              ],
            }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: "Card result" }] }
            : {
                contents: [
                  { uri: "ui://card", text: "Card", mimeType: "text/html+mcp" },
                ],
              };
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "fixture-session",
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  const config = {
    discoveryFailureMode: "throw" as "throw" | "continue",
    mcpServers: [
      {
        type: "http" as const,
        url,
        serverId: "cards",
        headers: { Authorization: "Bearer fixture-token" },
      },
      ...(sharedEndpoint
        ? [
            {
              type: "http" as const,
              url,
              serverId: "other",
              headers: { Authorization: "Bearer other-token" },
            },
          ]
        : []),
    ],
  };
  const middleware = new MCPAppsMiddleware(config);
  const agent = new MockAgent();
  return {
    requests,
    isStalledDeleteClosed: () => stalledDeleteClosed,
    agent,
    config,
    discover: () =>
      firstValueFrom(
        middleware.run(createRunAgentInput(), agent).pipe(toArray()),
      ),
    run: (
      method: string,
      serverId: string | undefined = "cards",
      hashOnly = false,
    ) =>
      firstValueFrom(
        middleware
          .run(
            createRunAgentInput({
              forwardedProps: {
                __proxiedMCPRequest: {
                  serverId: hashOnly ? undefined : serverId,
                  serverHash: getServerHash({ type: "http", url }),
                  method,
                  params:
                    method === "tools/call"
                      ? { name: "card", arguments: {} }
                      : { uri: "ui://card" },
                },
              },
            }),
            agent,
          )
          .pipe(toArray()),
      ),
    teardown: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("blocked proxy methods do not initialize an MCP session", async () => {
  const { run, requests, agent, teardown } = await setup();
  try {
    const events = await run("tools/list");
    expect(events.at(-1)).toMatchObject({
      result: { error: expect.stringContaining("not allowed") },
    });
    expect(requests).toEqual([]);
    expect(agent.runCalls).toEqual([]);
  } finally {
    await teardown();
  }
});

test("successful HTTP proxy requests delete their authenticated MCP session", async () => {
  const { run, requests, teardown } = await setup();
  try {
    const events = await run("resources/read");
    expect(events.at(-1)).toMatchObject({
      result: { contents: [{ text: "Card" }] },
    });
    expect(
      requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer fixture-token",
      ),
    ).toBe(true);
  } finally {
    await teardown();
  }
});

test.each(["http", "sse"] as const)(
  "%s server hashes do not expose a credential checksum",
  (type) => {
    const publicServer = { type, url: "https://mcp.example.test" };
    expect(
      getServerHash({
        ...publicServer,
        headers: { Authorization: "guessable-token" },
      }),
    ).toBe(getServerHash(publicServer));
  },
);

test("servers sharing a public endpoint require distinct server IDs", () => {
  expect(
    () =>
      new MCPAppsMiddleware({
        mcpServers: [
          {
            type: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: "first" },
          },
          {
            type: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: "second" },
          },
        ],
      }),
  ).toThrow("distinct serverId");
});

test("explicit IDs select the right credentials on a shared endpoint", async () => {
  const { run, requests, teardown } = await setup(true);
  try {
    const events = await run("resources/read", "other");
    expect(events.at(-1)).toMatchObject({
      result: { contents: [{ text: "Card" }] },
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer other-token",
      ),
    ).toBe(true);
  } finally {
    await teardown();
  }
});

test("hash-only requests cannot select an ambiguous credential scope", async () => {
  const { run, requests, teardown } = await setup(true);
  try {
    const events = await run("resources/read", undefined, true);
    expect(events.at(-1)).toMatchObject({
      result: { error: expect.stringContaining("Unknown server") },
    });
    expect(requests).toEqual([]);
  } finally {
    await teardown();
  }
});

test("duplicate explicit server IDs are rejected", () => {
  expect(
    () =>
      new MCPAppsMiddleware({
        mcpServers: [
          { type: "http", url: "https://one.example.test", serverId: "cards" },
          { type: "http", url: "https://two.example.test", serverId: "cards" },
        ],
      }),
  ).toThrow("distinct serverId");
});

test("an unresponsive DELETE cannot hold a completed proxy result", async () => {
  const { run, requests, teardown } = await setup(false, true);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const events = await Promise.race([
      run("resources/read"),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("session cleanup did not finish")),
          4500,
        );
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      result: { contents: [{ text: "Card" }] },
    });
    expect(
      requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  } finally {
    clearTimeout(deadline);
    await teardown();
  }
}, 6000);

test("MCP redirects cannot forward configured credentials", async () => {
  const { run, requests, teardown } = await setup(false, false, true);
  try {
    await run("resources/read");
    expect(requests).toHaveLength(1);
  } finally {
    await teardown();
  }
});

test("strict discovery failures stop the agent without exposing upstream diagnostics", async () => {
  const { discover, agent, teardown } = await setup(false, false, false, true);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(discover()).rejects.toThrow("MCP tool discovery failed");
    expect(agent.runCalls).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "MCP tool discovery failed",
      expect.objectContaining({
        serverId: "cards",
        serverHash: expect.any(String),
      }),
      expect.any(Error),
    );
    expect(String(log.mock.calls[0][2])).toContain("private-auth-diagnostic");
  } finally {
    log.mockRestore();
    await teardown();
  }
});

test("proxy errors do not expose upstream diagnostics", async () => {
  const { run, teardown } = await setup(false, false, false, true);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const events = await run("resources/read");
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP request failed" },
    });
    expect(JSON.stringify(events)).not.toContain("private-auth-diagnostic");
    expect(log).toHaveBeenCalledWith(
      "MCP proxy request failed",
      expect.objectContaining({
        serverId: "cards",
        serverHash: expect.any(String),
      }),
      expect.any(Error),
    );
    expect(String(log.mock.calls[0][2])).toContain("private-auth-diagnostic");
  } finally {
    log.mockRestore();
    await teardown();
  }
});

test("legacy SSE reentry keeps trusted authentication on GET and POST", async () => {
  const requests: Array<{ method?: string; authorization?: string }> = [];
  const sdkServer = new Server(
    { name: "legacy-fixture", version: "1" },
    { capabilities: {} },
  );
  let transport: SSEServerTransport | undefined;
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
    });
    if (request.headers.authorization !== "Bearer legacy-secret") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET") {
      transport = new SSEServerTransport("/messages", response);
      await sdkServer.connect(transport);
    } else if (transport) {
      await transport.handlePostMessage(request, response);
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No fixture address");
    const middleware = new MCPAppsMiddleware({
      mcpServers: [
        {
          type: "sse",
          url: `http://127.0.0.1:${address.port}/sse`,
          serverId: "legacy",
          headers: { Authorization: "Bearer legacy-secret" },
        },
      ],
    });
    const agent = new MockAgent();
    const events = await firstValueFrom(
      middleware
        .run(
          createRunAgentInput({
            forwardedProps: {
              __proxiedMCPRequest: { serverId: "legacy", method: "ping" },
            },
          }),
          agent,
        )
        .pipe(toArray()),
    );
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", result: {} });
    expect(agent.runCalls).toEqual([]);
    expect(requests.some((request) => request.method === "GET")).toBe(true);
    expect(requests.some((request) => request.method === "POST")).toBe(true);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer legacy-secret",
      ),
    ).toBe(true);
  } finally {
    await sdkServer.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("authenticated discovery and tool execution delete both sessions", async () => {
  const { discover, agent, requests, teardown } = await setup();
  agent.setEvents([
    createRunStartedEvent(),
    createToolCallStartEvent("call", "card"),
    createToolCallArgsEvent("call", "{}"),
    createToolCallEndEvent("call"),
    createRunFinishedEvent(),
  ]);
  try {
    const events = await discover();
    expect(agent.runCalls[0].tools.map((tool) => tool.name)).toContain("card");
    expect(events.some((event) => event.type === "ACTIVITY_SNAPSHOT")).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
    expect(
      requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(2);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer fixture-token",
      ),
    ).toBe(true);
  } finally {
    await teardown();
  }
});

test.each(["nested", "both"] as const)(
  "discovery uses current MCP metadata (%s)",
  async (metadata) => {
    const { discover, agent, teardown } = await setup(
      false,
      false,
      false,
      false,
      metadata,
    );
    agent.setEvents([
      createRunStartedEvent(),
      createToolCallStartEvent("call", "card"),
      createToolCallArgsEvent("call", "{}"),
      createToolCallEndEvent("call"),
      createRunFinishedEvent(),
    ]);
    try {
      const events = await discover();
      expect(agent.runCalls[0].tools.map((tool) => tool.name)).toContain(
        "card",
      );
      expect(
        events.find((event) => event.type === "ACTIVITY_SNAPSHOT"),
      ).toMatchObject({ content: { resourceUri: "ui://card" } });
    } finally {
      await teardown();
    }
  },
);

test.each([undefined, [], ["model"], ["app"], ["app", "model"]])(
  "discovery respects tool visibility %j",
  async (visibility) => {
    const { discover, agent, run, requests, teardown } = await setup(
      false,
      false,
      false,
      false,
      "nested",
      { visibility },
    );
    try {
      await discover();
      expect(agent.runCalls[0].tools.some((tool) => tool.name === "card")).toBe(
        visibility === undefined || visibility.includes("model"),
      );
      if (visibility?.length === 1 && visibility[0] === "app") {
        const events = await run("tools/call");
        expect(events.at(-1)).toMatchObject({
          result: { content: [{ text: "Card result" }] },
        });
        expect(requests.some((request) => request.rpc === "tools/call")).toBe(
          true,
        );
        expect(agent.runCalls).toHaveLength(1);
      }
    } finally {
      await teardown();
    }
  },
);

test("continue discovery names the failing server and retains the error", async () => {
  const { discover, agent, config, teardown } = await setup(
    false,
    false,
    false,
    true,
  );
  config.discoveryFailureMode = "continue";
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await discover();
    expect(agent.runCalls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "MCP tool discovery failed",
      expect.objectContaining({
        serverId: "cards",
        serverHash: expect.any(String),
      }),
      expect.any(Error),
    );
    expect(String(log.mock.calls[0][2])).toContain("private-auth-diagnostic");
  } finally {
    log.mockRestore();
    await teardown();
  }
});

test.each(["nested", "both"] as const)(
  "app-only %s metadata stays hidden from the model",
  async (metadata) => {
    const fixture = await setup(false, false, false, false, metadata, {
      visibility: ["app"],
    });
    try {
      await fixture.discover();
      expect(fixture.agent.runCalls[0].tools).toEqual([]);
    } finally {
      await fixture.teardown();
    }
  },
);

test.each([
  ["proxy", "initialized-error"],
  ["proxy", "unsupported-version"],
  ["discovery", "initialized-error"],
  ["discovery", "unsupported-version"],
] as const)(
  "%s deletes authenticated session after %s",
  async (operation, initializationFailure) => {
    const fixture = await setup(false, false, false, false, "legacy", {
      initializationFailure,
    });
    try {
      if (operation === "proxy") {
        expect((await fixture.run("resources/read")).at(-1)).toMatchObject({
          result: { error: "Error: MCP request failed" },
        });
      } else {
        await expect(fixture.discover()).rejects.toThrow(
          "MCP tool discovery failed",
        );
      }
      expect(fixture.agent.runCalls).toEqual([]);
      expect(
        fixture.requests.filter((request) => request.method === "DELETE"),
      ).toEqual([
        expect.objectContaining({
          authorization: "Bearer fixture-token",
          sessionId: "fixture-session",
        }),
      ]);
    } finally {
      await fixture.teardown();
    }
  },
);

test("failed handshake bounds and aborts stalled session cleanup", async () => {
  const fixture = await setup(false, true, false, false, "legacy", {
    initializationFailure: "initialized-error",
  });
  try {
    const started = Date.now();
    expect((await fixture.run("resources/read")).at(-1)).toMatchObject({
      result: { error: "Error: MCP request failed" },
    });
    expect(Date.now() - started).toBeLessThan(4500);
    expect(
      fixture.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
    await vi.waitFor(() => expect(fixture.isStalledDeleteClosed()).toBe(true));
    expect(fixture.agent.runCalls).toEqual([]);
  } finally {
    await fixture.teardown();
  }
}, 6000);

test("rejected session cleanup preserves the private handshake failure", async () => {
  const fixture = await setup(false, false, false, false, "legacy", {
    initializationFailure: "initialized-error",
    rejectDelete: true,
  });
  try {
    const events = await fixture.run("resources/read");
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP request failed" },
    });
    expect(
      fixture.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private-cleanup-diagnostic");
    expect(JSON.stringify(events)).not.toContain(
      "private-initialization-diagnostic",
    );
    expect(fixture.agent.runCalls).toEqual([]);
  } finally {
    await fixture.teardown();
  }
});

test.each([false, true])(
  "proxy preserves its result when client close rejects (handshake failure: %s)",
  async (failHandshake) => {
    const fixture = await setup(false, false, false, false, "legacy", {
      initializationFailure: failHandshake ? "unsupported-version" : undefined,
    });
    const closeError = new Error(
      "private-close-diagnostic: Bearer fixture-token",
    );
    const originalClose = Client.prototype.close;
    const close = vi
      .spyOn(Client.prototype, "close")
      .mockImplementation(async function (this: Client) {
        await originalClose.call(this);
        throw closeError;
      });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = await fixture.run("resources/read");
      expect(events.at(-1)).toMatchObject({
        result: failHandshake
          ? { error: "Error: MCP request failed" }
          : { contents: [{ text: "Card" }] },
      });
      expect(JSON.stringify(events)).not.toContain("private-close-diagnostic");
      expect(log).toHaveBeenCalledWith(
        "MCP session cleanup failed",
        {
          serverId: "cards",
          serverHash: getServerHash(fixture.config.mcpServers[0]),
        },
        closeError,
      );
    } finally {
      close.mockRestore();
      log.mockRestore();
      await fixture.teardown();
    }
  },
);
