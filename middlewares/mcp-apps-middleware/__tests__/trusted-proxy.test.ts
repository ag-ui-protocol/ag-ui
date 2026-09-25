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

type ToolListPage = {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }>;
  nextCursor?: string;
};

/** Serve the MCP HTTP protocol and record transport effects on real sockets. */
async function setup(
  sharedEndpoint = false,
  stallDelete = false,
  redirect = false,
  rejectAuth = false,
  metadata: "legacy" | "nested" | "both" = "legacy",
  options: {
    visibility?: unknown;
    toolName?: string;
    toolListPages?: Array<ToolListPage>;
    toolListSequences?: Array<Array<ToolListPage>>;
    failToolsList?: boolean;
    failToolsListCursors?: Array<string>;
    failToolsListPageIndexes?: Array<number>;
    initializationFailure?: "initialized-error" | "unsupported-version";
    rejectDelete?: boolean;
    toolListPagesByAuthorization?: Record<string, Array<ToolListPage>>;
    toolCallTextByAuthorization?: Record<string, string>;
    additionalServer?: {
      serverId: string;
      token: string;
      toolListPages: Array<ToolListPage>;
      toolCallText: string;
    };
  } = {},
) {
  const requests: Array<{
    serverId: string;
    method: string;
    authorization?: string;
    rpc?: string;
    sessionId?: string;
    mimeTypes?: unknown;
    cursor?: unknown;
    toolListSequence?: number;
  }> = [];
  let stalledDeleteClosed = false;
  let toolListSequenceIndex = 0;
  let activeToolListPages: Array<ToolListPage> | undefined;
  let activeToolListSequence: number | undefined;
  const server = createServer(async (request, response) => {
    const entry = {
      serverId: "cards",
      method: request.method!,
      authorization: request.headers.authorization,
      sessionId: request.headers["mcp-session-id"]?.toString(),
      rpc: undefined as string | undefined,
      mimeTypes: undefined as unknown,
      cursor: undefined as unknown,
      toolListSequence: undefined as number | undefined,
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
    entry.cursor = message.params?.cursor;
    if (message.method === "initialize")
      entry.mimeTypes =
        message.params.capabilities?.extensions?.[
          "io.modelcontextprotocol/ui"
        ]?.mimeTypes;
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
    if (message.method === "tools/list" && options.failToolsList) {
      response.writeHead(500).end("private-tools-list-diagnostic");
      return;
    }
    const defaultToolListPages = [
      {
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
                      ...("visibility" in options
                        ? { visibility: options.visibility }
                        : {}),
                    },
                    ...(metadata === "both"
                      ? { "ui/resourceUri": "ui://legacy" }
                      : {}),
                  },
          },
        ],
      },
    ];
    const toolListSequences =
      options.toolListPagesByAuthorization?.[entry.authorization ?? ""] !==
      undefined
        ? [options.toolListPagesByAuthorization[entry.authorization ?? ""]]
        : (options.toolListSequences ??
          (options.toolListPages ? [options.toolListPages] : undefined));
    if (
      message.method === "tools/list" &&
      message.params?.cursor === undefined
    ) {
      activeToolListSequence =
        toolListSequences === undefined
          ? undefined
          : Math.min(toolListSequenceIndex, toolListSequences.length - 1);
      activeToolListPages =
        activeToolListSequence === undefined
          ? defaultToolListPages
          : toolListSequences[activeToolListSequence];
      toolListSequenceIndex += 1;
    }
    if (message.method === "tools/list") {
      entry.toolListSequence = activeToolListSequence;
    }
    const toolListPages = activeToolListPages ?? defaultToolListPages;
    const toolListPageIndex =
      message.params?.cursor === undefined
        ? 0
        : toolListPages.findIndex(
            (_page, index) =>
              index > 0 &&
              toolListPages[index - 1].nextCursor === message.params.cursor,
          );
    if (
      message.method === "tools/list" &&
      ((typeof message.params?.cursor === "string" &&
        options.failToolsListCursors?.includes(message.params.cursor)) ||
        options.failToolsListPageIndexes?.includes(toolListPageIndex))
    ) {
      response.writeHead(500).end("private-tools-list-diagnostic");
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
          ? (toolListPages[toolListPageIndex] ?? { tools: [] })
          : message.method === "tools/call"
            ? {
                content: [
                  {
                    type: "text",
                    text:
                      options.toolCallTextByAuthorization?.[
                        entry.authorization ?? ""
                      ] ?? "Card result",
                  },
                ],
              }
            : {
                contents: [
                  {
                    uri: "ui://card",
                    text: "Card",
                    mimeType: "text/html;profile=mcp-app",
                  },
                ],
              };
    response.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "fixture-session",
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  const additionalServer =
    options.additionalServer === undefined
      ? undefined
      : createServer(async (request, response) => {
          const entry = {
            serverId: options.additionalServer!.serverId,
            method: request.method!,
            authorization: request.headers.authorization,
            sessionId: request.headers["mcp-session-id"]?.toString(),
            rpc: undefined as string | undefined,
            mimeTypes: undefined as unknown,
            cursor: undefined as unknown,
            toolListSequence: undefined as number | undefined,
          };
          requests.push(entry);
          if (request.method === "DELETE") {
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
          entry.cursor = message.params?.cursor;
          if (message.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          const toolListPageIndex =
            message.params?.cursor === undefined
              ? 0
              : options.additionalServer!.toolListPages.findIndex(
                  (_page, index) =>
                    index > 0 &&
                    options.additionalServer!.toolListPages[index - 1]
                      .nextCursor === message.params.cursor,
                );
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: message.params.protocolVersion,
                  capabilities: { resources: {}, tools: {} },
                  serverInfo: { name: "additional-fixture", version: "1" },
                }
              : message.method === "tools/list"
                ? (options.additionalServer!.toolListPages[
                    toolListPageIndex
                  ] ?? { tools: [] })
                : message.method === "tools/call"
                  ? {
                      content: [
                        {
                          type: "text",
                          text: options.additionalServer!.toolCallText,
                        },
                      ],
                    }
                  : {
                      contents: [
                        {
                          uri: "ui://card",
                          text: "Additional Card",
                          mimeType: "text/html;profile=mcp-app",
                        },
                      ],
                    };
          response.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": `${options.additionalServer!.serverId}-session`,
          });
          response.end(
            JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
          );
        });
  additionalServer?.listen(0, "127.0.0.1");
  await Promise.all([
    once(server, "listening"),
    ...(additionalServer ? [once(additionalServer, "listening")] : []),
  ]);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture did not listen");
  const url = `http://127.0.0.1:${address.port}`;
  const additionalAddress = additionalServer?.address();
  if (additionalAddress !== undefined && typeof additionalAddress === "string")
    throw new Error("Additional fixture did not listen");
  const additionalUrl =
    additionalAddress === undefined
      ? undefined
      : `http://127.0.0.1:${additionalAddress.port}`;
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
      ...(options.additionalServer && additionalUrl
        ? [
            {
              type: "http" as const,
              url: additionalUrl,
              serverId: options.additionalServer.serverId,
              headers: {
                Authorization: `Bearer ${options.additionalServer.token}`,
              },
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
                      ? { name: options.toolName ?? "card", arguments: {} }
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
      additionalServer?.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => server.close(() => resolve())),
        ...(additionalServer
          ? [
              new Promise<void>((resolve) =>
                additionalServer.close(() => resolve()),
              ),
            ]
          : []),
      ]);
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

test("tools/call metadata comes from the selected same-name server", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    toolListPages: [
      {
        tools: [
          {
            name: "card",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      },
    ],
    additionalServer: {
      serverId: "other",
      token: "other-token",
      toolCallText: "Other card result",
      toolListPages: [
        {
          tools: [
            {
              name: "card",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["app"] } },
            },
          ],
        },
      ],
    },
  });
  try {
    const events = await fixture.run("tools/call", "other");
    expect(events.at(-1)).toMatchObject({
      result: { content: [{ text: "Other card result" }] },
    });
    expect(
      fixture.requests
        .filter((request) => request.rpc === "tools/list")
        .map((request) => request.serverId),
    ).toEqual(["other"]);
    expect(
      fixture.requests
        .filter((request) => request.rpc === "tools/call")
        .map((request) => ({
          serverId: request.serverId,
          authorization: request.authorization,
        })),
    ).toEqual([{ serverId: "other", authorization: "Bearer other-token" }]);
    expect(
      fixture.requests.some((request) => request.serverId === "cards"),
    ).toBe(false);
  } finally {
    await fixture.teardown();
  }
});

test("tools/call metadata comes from the selected credential on a shared endpoint", async () => {
  const fixture = await setup(true, false, false, false, "nested", {
    toolListPagesByAuthorization: {
      "Bearer fixture-token": [
        {
          tools: [
            {
              name: "card",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["model"] } },
            },
          ],
        },
      ],
      "Bearer other-token": [
        {
          tools: [
            {
              name: "card",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui: { visibility: ["app"] } },
            },
          ],
        },
      ],
    },
    toolCallTextByAuthorization: {
      "Bearer fixture-token": "Cards credential result",
      "Bearer other-token": "Other credential result",
    },
  });
  try {
    const events = await fixture.run("tools/call", "other");
    expect(events.at(-1)).toMatchObject({
      result: { content: [{ text: "Other credential result" }] },
    });
    expect(
      fixture.requests
        .filter(
          (request) =>
            request.rpc === "tools/list" || request.rpc === "tools/call",
        )
        .map((request) => ({
          rpc: request.rpc,
          authorization: request.authorization,
        })),
    ).toEqual([
      { rpc: "tools/list", authorization: "Bearer other-token" },
      { rpc: "tools/call", authorization: "Bearer other-token" },
    ]);

    const hashOnlyEvents = await fixture.run("tools/call", undefined, true);
    expect(hashOnlyEvents.at(-1)).toMatchObject({
      result: { error: expect.stringContaining("Unknown server") },
    });
    expect(
      fixture.requests
        .filter(
          (request) =>
            request.rpc === "tools/list" || request.rpc === "tools/call",
        )
        .map((request) => request.authorization),
    ).toEqual(["Bearer other-token", "Bearer other-token"]);
  } finally {
    await fixture.teardown();
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

test.each([
  ["model-only visibility", ["model"]],
  ["empty visibility", []],
  ["malformed visibility", "app"],
  ["unknown visibility value", ["app", "admin"]],
  ["malformed ui metadata", { visibility: ["app"] }],
] as const)(
  "proxy denies %s without upstream tool execution",
  async (_label, visibility) => {
    const fixture = await setup(false, false, false, false, "nested", {
      visibility,
    });
    try {
      const events = await fixture.run("tools/call");
      expect(events.at(-1)).toMatchObject({
        result: { error: "Error: MCP tool unavailable to this app" },
      });
      expect(
        fixture.requests.some((request) => request.rpc === "tools/call"),
      ).toBe(false);
    } finally {
      await fixture.teardown();
    }
  },
);

test.each([
  ["null ui metadata", null],
  ["non-object ui metadata", "ui://card"],
] as const)(
  "proxy denies %s without upstream tool execution",
  async (_label, ui) => {
    const fixture = await setup(false, false, false, false, "nested", {
      toolListPages: [
        {
          tools: [
            {
              name: "card",
              description: "Card",
              inputSchema: { type: "object", properties: {} },
              _meta: { ui },
            },
          ],
        },
      ],
    });
    try {
      const events = await fixture.run("tools/call");
      expect(events.at(-1)).toMatchObject({
        result: { error: "Error: MCP tool unavailable to this app" },
      });
      expect(
        fixture.requests.some((request) => request.rpc === "tools/call"),
      ).toBe(false);
    } finally {
      await fixture.teardown();
    }
  },
);

test("proxy allows omitted visibility and still executes the tool", async () => {
  const fixture = await setup(false, false, false, false, "nested");
  try {
    const events = await fixture.run("tools/call");
    expect(events.at(-1)).toMatchObject({
      result: { content: [{ text: "Card result" }] },
    });
    expect(
      fixture.requests.some((request) => request.rpc === "tools/call"),
    ).toBe(true);
  } finally {
    await fixture.teardown();
  }
});

test("proxy refreshes tool metadata between proxied calls", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    toolListSequences: [
      [
        {
          tools: [
            {
              name: "card",
              description: "Card",
              inputSchema: { type: "object", properties: {} },
              _meta: {
                ui: { resourceUri: "ui://card", visibility: ["app"] },
              },
            },
          ],
        },
      ],
      [
        {
          tools: [
            {
              name: "card",
              description: "Card",
              inputSchema: { type: "object", properties: {} },
              _meta: {
                ui: { resourceUri: "ui://card", visibility: ["model"] },
              },
            },
          ],
        },
      ],
    ],
  });
  try {
    const allowedEvents = await fixture.run("tools/call");
    const deniedEvents = await fixture.run("tools/call");

    expect(allowedEvents.at(-1)).toMatchObject({
      result: { content: [{ text: "Card result" }] },
    });
    expect(deniedEvents.at(-1)).toMatchObject({
      result: { error: "Error: MCP tool unavailable to this app" },
    });
    expect(
      fixture.requests
        .filter((request) => request.rpc === "tools/list")
        .map((request) => ({
          cursor: request.cursor,
          sequence: request.toolListSequence,
        })),
    ).toEqual([
      { cursor: undefined, sequence: 0 },
      { cursor: undefined, sequence: 1 },
    ]);
    expect(
      fixture.requests.filter((request) => request.rpc === "tools/call"),
    ).toHaveLength(1);
  } finally {
    await fixture.teardown();
  }
});

test("proxy finds app-visible tools on later metadata pages", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    toolListPages: [
      { tools: [], nextCursor: "page-2" },
      {
        tools: [
          {
            name: "card",
            description: "Card",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      },
    ],
  });
  try {
    const events = await fixture.run("tools/call");
    expect(events.at(-1)).toMatchObject({
      result: { content: [{ text: "Card result" }] },
    });
    expect(
      fixture.requests.filter((request) => request.rpc === "tools/list"),
    ).toHaveLength(2);
    expect(
      fixture.requests
        .filter((request) => request.rpc === "tools/list")
        .map((request) => request.cursor),
    ).toEqual([undefined, "page-2"]);
    expect(
      fixture.requests.some((request) => request.rpc === "tools/call"),
    ).toBe(true);
  } finally {
    await fixture.teardown();
  }
});

test("proxy hides diagnostics and skips tool execution when a later metadata page fails", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    toolListPages: [
      { tools: [], nextCursor: "page-2" },
      {
        tools: [
          {
            name: "card",
            description: "Card",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      },
    ],
    failToolsListCursors: ["page-2"],
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const events = await fixture.run("tools/call");
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP request failed" },
    });
    expect(JSON.stringify(events)).not.toContain(
      "private-tools-list-diagnostic",
    );
    expect(log).toHaveBeenCalledWith(
      "MCP proxy request failed",
      expect.objectContaining({
        serverId: "cards",
        serverHash: expect.any(String),
      }),
      expect.any(Error),
    );
    expect(String(log.mock.calls[0][2])).toContain(
      "private-tools-list-diagnostic",
    );
    expect(
      fixture.requests
        .filter((request) => request.rpc === "tools/list")
        .map((request) => request.cursor),
    ).toEqual([undefined, "page-2"]);
    expect(
      fixture.requests.some((request) => request.rpc === "tools/call"),
    ).toBe(false);
  } finally {
    log.mockRestore();
    await fixture.teardown();
  }
});

test("proxy denies unknown tools without upstream tool execution", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    toolName: "missing",
  });
  try {
    const events = await fixture.run("tools/call");
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP tool unavailable to this app" },
    });
    expect(
      fixture.requests.some((request) => request.rpc === "tools/call"),
    ).toBe(false);
  } finally {
    await fixture.teardown();
  }
});

test("proxy fails closed when target name is duplicated in catalog", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    toolListPages: [
      {
        tools: [
          {
            name: "card",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
          {
            name: "card",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
      },
    ],
  });
  try {
    const events = await fixture.run("tools/call");
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP tool unavailable to this app" },
    });
    expect(
      fixture.requests.some((request) => request.rpc === "tools/call"),
    ).toBe(false);
  } finally {
    await fixture.teardown();
  }
});

test("proxy fails closed when metadata pagination repeats a cursor", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    toolListPages: [
      { tools: [], nextCursor: "same-cursor" },
      {
        tools: [
          {
            name: "card",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["app"] } },
          },
        ],
        nextCursor: "same-cursor",
      },
    ],
  });
  try {
    const events = await fixture.run("tools/call");
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP request failed" },
    });
    expect(
      fixture.requests.some((request) => request.rpc === "tools/call"),
    ).toBe(false);
  } finally {
    await fixture.teardown();
  }
});

test("proxy metadata failures hide diagnostics and skip upstream tool execution", async () => {
  const fixture = await setup(false, false, false, false, "nested", {
    failToolsList: true,
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const events = await fixture.run("tools/call");
    expect(events.at(-1)).toMatchObject({
      result: { error: "Error: MCP request failed" },
    });
    expect(JSON.stringify(events)).not.toContain(
      "private-tools-list-diagnostic",
    );
    expect(log).toHaveBeenCalledWith(
      "MCP proxy request failed",
      expect.objectContaining({
        serverId: "cards",
        serverHash: expect.any(String),
      }),
      expect.any(Error),
    );
    expect(String(log.mock.calls[0][2])).toContain(
      "private-tools-list-diagnostic",
    );
    expect(
      fixture.requests.some((request) => request.rpc === "tools/call"),
    ).toBe(false);
  } finally {
    log.mockRestore();
    await fixture.teardown();
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

test("all HTTP connections advertise the standard MCP Apps MIME type", async () => {
  const { discover, run, agent, requests, teardown } = await setup();
  agent.setEvents([
    createRunStartedEvent(),
    createToolCallStartEvent("mime-call", "card"),
    createToolCallArgsEvent("mime-call", "{}"),
    createToolCallEndEvent("mime-call"),
    createRunFinishedEvent(),
  ]);
  try {
    await discover();
    await run("resources/read");
    await run("tools/call");
    const initializations = requests.filter(
      (request) => request.rpc === "initialize",
    );
    expect(initializations.length).toBeGreaterThanOrEqual(4);
    for (const request of initializations) {
      expect(request.mimeTypes).toContain("text/html;profile=mcp-app");
    }
  } finally {
    await teardown();
  }
});
