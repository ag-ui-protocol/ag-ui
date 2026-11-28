import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { A2UI_MIME_TYPE } from "../../src/a2ui";

export const BASIC_CATALOG_ID =
  "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

export const customerComponents = [
  { id: "root", component: "Card", child: "details" },
  { id: "details", component: "Column", children: ["name", "email"] },
  { id: "name", component: "Text", text: { "@path": "/customer/name" } },
  {
    id: "email",
    component: "Text",
    variant: "caption",
    text: { "@path": "/customer/email" },
  },
];

export const customerTemplate = [
  {
    version: "1.0",
    createSurface: {
      surfaceId: "customer-details",
      catalogId: BASIC_CATALOG_ID,
    },
  },
  {
    version: "1.0",
    updateComponents: {
      surfaceId: "customer-details",
      components: customerComponents,
    },
  },
];

const compactTemplate = [
  {
    version: "1.0",
    createSurface: {
      surfaceId: "customer-compact",
      catalogId: BASIC_CATALOG_ID,
      components: [
        { id: "root", component: "Text", text: { "@path": "/customer/name" } },
      ],
    },
  },
];

const unknownComponentTemplate = [
  {
    version: "1.0",
    createSurface: {
      surfaceId: "unknown",
      catalogId: BASIC_CATALOG_ID,
      components: [{ id: "root", component: "Bogus" }],
    },
  },
];

export const resourceReads = new Map<string, number>();

export const actionCalls: Record<string, unknown>[] = [];

export function customer(id: string) {
  return { id, name: `Customer ${id}`, email: `${id}@example.com` };
}

interface ToolFixture {
  tool: Tool;
  execute(args: Record<string, unknown>): CallToolResult;
}

interface ResourceFixture {
  mimeType: string;
  read(reads: number): string;
}

const idInputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

const actionInputSchema: Tool["inputSchema"] = {
  type: "object",
  properties: {
    name: { type: "string" },
    surfaceId: { type: "string" },
    sourceComponentId: { type: "string" },
    timestamp: { type: "string" },
    context: { type: "object" },
  },
  required: ["name", "surfaceId", "sourceComponentId", "timestamp", "context"],
};

const tools: ToolFixture[] = [
  a2uiTool("getCustomer", "a2ui://customer-details", (id) => ({
    content: [{ type: "text", text: `Customer ${id} loaded.` }],
    structuredContent: { customer: customer(id) },
  })),
  a2uiTool("getCustomerCompact", "a2ui://customer-details", (id) => ({
    content: [{ type: "text", text: `Customer ${id} loaded.` }],
    structuredContent: { customer: customer(id) },
    _meta: {
      ui: { resourceUri: "a2ui://customer-compact", mimeType: A2UI_MIME_TYPE },
    },
  })),
  a2uiTool("getCustomerOps", "a2ui://customer-details", (id) => {
    const operations = [
      {
        version: "1.0",
        updateDataModel: {
          surfaceId: "customer-details",
          path: "/customer",
          value: customer(id),
        },
      },
    ];
    return {
      content: [
        { type: "text", text: `Customer ${id} loaded.` },
        {
          type: "resource",
          resource: {
            uri: "a2ui://customer-details/data",
            mimeType: A2UI_MIME_TYPE,
            text: JSON.stringify(operations),
          },
        },
      ],
      structuredContent: { customer: { name: "not applied" } },
    };
  }),
  a2uiTool("getBroken", "a2ui://broken", () => ({
    content: [{ type: "text", text: "Broken." }],
    structuredContent: {},
  })),
  a2uiTool("getFlaky", "a2ui://flaky", (id) => ({
    content: [{ type: "text", text: "Flaky." }],
    structuredContent: { customer: customer(id) },
  })),
  a2uiTool("getUnknownComponent", "a2ui://unknown", () => ({
    content: [{ type: "text", text: "Unknown." }],
    structuredContent: {},
  })),
  a2uiTool("getPlain", "a2ui://plain", () => ({
    content: [{ type: "text", text: "Plain." }],
    structuredContent: {},
  })),
  a2uiTool("getFailing", "a2ui://customer-details", () => ({
    isError: true,
    content: [{ type: "text", text: "Failed." }],
  })),
  {
    tool: {
      name: "getWeather",
      description: "Weather without UI.",
      inputSchema: idInputSchema,
    },
    execute: () => ({ content: [{ type: "text", text: "Sunny." }] }),
  },
  {
    tool: {
      name: "showWidget",
      description: "MCP App widget.",
      inputSchema: idInputSchema,
      _meta: { ui: { resourceUri: "ui://widget" } },
    },
    execute: () => ({ content: [{ type: "text", text: "Widget." }] }),
  },
];

const actionTool: ToolFixture = {
  tool: {
    name: "a2ui_action",
    description: "Handles A2UI actions.",
    inputSchema: actionInputSchema,
    _meta: { ui: { visibility: ["app"] } },
  },
  execute: (input) => {
    actionCalls.push(input);
    const surfaceId = String(input["surfaceId"]);
    const context = input["context"] as Record<string, unknown>;
    const id = String(context["id"]);

    if (input["name"] === "reloadCustomer") {
      return a2uiActionResult({
        version: "1.0",
        updateDataModel: { surfaceId, path: "/customer", value: customer(id) },
      });
    }

    if (input["name"] === "oversized") {
      return a2uiActionResult({
        version: "1.0",
        updateDataModel: {
          surfaceId,
          path: "/customer/name",
          value: "x".repeat(4096),
        },
      });
    }

    if (input["name"] === "linkPanel") {
      return a2uiActionResult({
        version: "1.0",
        updateComponents: {
          surfaceId,
          components: [{ id: "root", component: "Card", child: "panel" }],
        },
      });
    }

    if (input["name"] === "addBogus") {
      return a2uiActionResult({
        version: "1.0",
        updateComponents: {
          surfaceId,
          components: [{ id: "name", component: "Bogus" }],
        },
      });
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown action ${input["name"]}.` }],
    };
  },
};

const resources: Record<string, ResourceFixture> = {
  "a2ui://customer-details": a2uiResource(() =>
    JSON.stringify(customerTemplate),
  ),
  "a2ui://customer-compact": a2uiResource(() =>
    JSON.stringify(compactTemplate),
  ),
  "a2ui://unknown": a2uiResource(() =>
    JSON.stringify(unknownComponentTemplate),
  ),
  "a2ui://broken": a2uiResource(() => "[{"),
  "a2ui://plain": { mimeType: "text/plain", read: () => "plain" },
  "ui://widget": {
    mimeType: "text/html;profile=mcp-app",
    read: () => "<p>widget</p>",
  },
  "a2ui://flaky": a2uiResource((reads) => {
    if (reads === 1) {
      throw new Error("temporarily unavailable");
    }
    return JSON.stringify(customerTemplate);
  }),
};

export function createFixtureServer(
  options: { withActions?: boolean } = {},
): Server {
  const available = options.withActions ? [...tools, actionTool] : tools;
  const server = new Server(
    { name: "a2ui-mcp-test", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: available.map((fixture) => fixture.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const fixture = available.find(
      (candidate) => candidate.tool.name === request.params.name,
    );
    if (!fixture) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Unknown tool ${request.params.name}.` },
        ],
      };
    }
    return fixture.execute(request.params.arguments ?? {});
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const resource = resources[uri];
    if (!resource) {
      throw new Error(`Unknown resource ${uri}.`);
    }
    const reads = (resourceReads.get(uri) ?? 0) + 1;
    resourceReads.set(uri, reads);
    const text = resource.read(reads);
    return { contents: [{ uri, mimeType: resource.mimeType, text }] };
  });

  return server;
}

function a2uiTool(
  name: string,
  resourceUri: string,
  execute: (id: string) => CallToolResult,
): ToolFixture {
  return {
    tool: {
      name,
      description: `${name} with A2UI.`,
      inputSchema: idInputSchema,
      _meta: { ui: { resourceUri, mimeType: A2UI_MIME_TYPE } },
    },
    execute: (args) => execute(String(args["id"])),
  };
}

function a2uiResource(read: (reads: number) => string): ResourceFixture {
  return { mimeType: A2UI_MIME_TYPE, read };
}

function a2uiActionResult(operation: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: "text", text: "Action handled." },
      {
        type: "resource",
        resource: {
          uri: "a2ui://action-result",
          mimeType: A2UI_MIME_TYPE,
          text: JSON.stringify([operation]),
        },
      },
    ],
  };
}
