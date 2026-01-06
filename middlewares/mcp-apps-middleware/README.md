# @ag-ui/mcp-apps-middleware

MCP Apps middleware for AG-UI that enables UI-enabled tools from MCP (Model Context Protocol) servers.

## Installation

```bash
npm install @ag-ui/mcp-apps-middleware
# or
pnpm add @ag-ui/mcp-apps-middleware
```

## Usage

```typescript
import { MCPAppsMiddleware } from "@ag-ui/mcp-apps-middleware";

const agent = new YourAgent().use(
  new MCPAppsMiddleware({
    mcpServers: [
      { type: "http", url: "http://localhost:3001/mcp" }
    ],
  })
);
```

## Features

- Discovers UI-enabled tools from MCP servers
- Injects tools into the agent's tool list
- Executes tool calls and fetches UI resources
- Emits activity snapshots for rendering MCP Apps UI

## Configuration

```typescript
interface MCPAppsMiddlewareConfig {
  mcpServers?: MCPClientConfig[];
}

type MCPClientConfig =
  | { type: "http"; url: string }
  | { type: "sse"; url: string; headers?: Record<string, string> };
```

## Activity Type

The middleware emits activity snapshots with type `"mcp-apps"`. You can use the exported constant:

```typescript
import { MCPAppsActivityType } from "@ag-ui/mcp-apps-middleware";

// MCPAppsActivityType === "mcp-apps"
```

## License

MIT
