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
      {
        type: "http",
        url: "http://localhost:3001/mcp",
        serverId: "weather-server",
      },
    ],
  }),
);
```

## Features

- Discovers UI-enabled tools from MCP servers
- Injects tools into the agent's tool list
- Executes tool calls and emits activity snapshots with resource URIs
- Supports proxied MCP requests for frontend resource fetching

## Configuration

```typescript
interface MCPAppsMiddlewareConfig {
  mcpServers?: MCPClientConfig[];
  discoveryFailureMode?: "continue" | "throw"; // Default: "continue"
}

type MCPClientConfig =
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      serverId?: string;
    }
  | {
      type: "sse";
      url: string;
      headers?: Record<string, string>;
      serverId?: string;
    };
```

### Server ID

The optional `serverId` field provides a stable identifier for the server. This is useful when:

- Server URLs may change (e.g., different environments)
- You want human-readable server identification
- Frontend code needs to reference servers by name

If `serverId` is not provided, the server is identified by an MD5 hash of its transport `type` and `url` only.

## Activity Snapshot

The middleware emits activity snapshots with the following structure:

```typescript
{
  type: "ACTIVITY_SNAPSHOT",
  activityType: "mcp-apps",
  content: {
    result: MCPToolCallResult,     // Result from the tool execution
    resourceUri: string,           // URI of the UI resource to fetch
    serverHash: string,            // MD5 hash of transport type and URL only
    serverId?: string,           // Server ID (if configured)
    toolInput: Record<string, unknown>  // Arguments passed to the tool
  },
  replace: true
}
```

The frontend should fetch the resource content via proxied MCP request using `resourceUri` and either `serverHash` or `serverId`.

## Proxied MCP Requests

The middleware supports proxied MCP requests from the frontend. Pass a `ProxiedMCPRequest` in `forwardedProps.__proxiedMCPRequest`:

```typescript
interface ProxiedMCPRequest {
  serverHash: string; // MD5 hash of transport type and URL only
  serverId?: string; // Optional server ID for lookup
  method: string; // MCP method (e.g., "resources/read", "tools/call")
  params?: Record<string, unknown>;
}
```

Server lookup prefers `serverId` if provided, falling back to `serverHash`.

## Exported Utilities

```typescript
import {
  MCPAppsActivityType, // "mcp-apps" constant
  getServerHash, // Hash transport type and URL; excludes headers
} from "@ag-ui/mcp-apps-middleware";
```

## Proxy connections

Requires `@modelcontextprotocol/sdk >=1.15.0`. Version 1.15.0 is the first release
with custom `fetch` support in both HTTP and SSE client transports, and it includes
HTTP `terminateSession()`. These APIs enforce the origin guard and session cleanup.
The lockfile pins this package's SDK to 1.15.0 so CI tests the minimum supported version.

The middleware accepts only `tools/call`, `resources/read`, `notifications/message`, and `ping` from an iframe proxy request.
It rejects other methods before it connects to the MCP server.
HTTP discovery, tool calls, and proxy requests delete their MCP sessions before closing the client.
Session deletion uses its own three-second abort signal so cleanup can run after a failed handshake aborts the SDK signal.
If a server rejects session deletion or does not respond within three seconds, the client still closes and preserves the original operation result.

Server hashes exclude headers so browser-visible references do not contain a checksum of credentials.
This changes hashes for servers configured with headers. Recreate activity messages after upgrading;
use stable `serverId` values for references that must survive configuration changes.
If multiple configurations share a transport type and URL, each must have a distinct `serverId`.
Hash-only requests for that endpoint are rejected because they cannot identify the intended credential scope.

MCP connections do not follow redirects, and transport requests must stay on the configured origin.
URLs must use HTTP(S) and must not contain embedded user credentials.

Discovery continues past unavailable servers by default. Set `discoveryFailureMode: "throw"`
to stop before invoking the agent if any configured server cannot provide its tools.
Proxy responses and thrown discovery errors omit raw upstream response bodies.
Server-side diagnostics include `serverId`, the credential-free server hash, and the
original error in both discovery modes and on proxy failures. Treat these logs as
operator-only data: upstream errors can include private response bodies.

## Tool visibility

Discovery reads `_meta.ui.resourceUri`, with `_meta["ui/resourceUri"]` as a legacy fallback.
When `_meta.ui.visibility` is omitted, tools remain visible to the model by default.
An explicit visibility list must include `"model"` for model-facing discovery.
Tools marked `["app"]` stay hidden from the model and remain callable through the iframe proxy.

## License

MIT
