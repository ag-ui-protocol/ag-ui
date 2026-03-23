# Using MCP Apps Middleware with ADK

This guide covers how to use the [`@ag-ui/mcp-apps-middleware`](../../../middlewares/mcp-apps-middleware/) with an ADK backend to render interactive UI components from MCP servers.

## Overview

The MCPAppsMiddleware is a TypeScript client-side middleware that discovers UI-enabled tools from MCP servers, injects them into the agent's tool list, and handles their execution. It works with ADK out of the box — no changes to your Python ADK agent are needed.

The middleware automatically:
- Discovers MCP tools with `_meta["ui/resourceUri"]` metadata
- Adds them to `RunAgentInput.tools` (which ADK receives via `AGUIToolset`)
- Intercepts pending tool calls after the run and executes them against the MCP server
- Emits `ACTIVITY_SNAPSHOT` events that the frontend uses to render the MCP app UI

## How ADK's Long-Running Tools Affect Behavior

ADK wraps all client-supplied tools as **long-running** (`is_long_running=True`). When the LLM calls an MCP tool, `ClientProxyTool` emits `TOOL_CALL_START/ARGS/END` events and returns `None` without waiting for a result. ADK then finishes the run.

The middleware catches this: it finds the pending tool call (no result message exists), executes the MCP tool server-side, and emits `TOOL_CALL_RESULT` + `ACTIVITY_SNAPSHOT`.

**The UI rendering works correctly.** The `ACTIVITY_SNAPSHOT` with `resourceUri` is what drives the frontend display, and this is emitted regardless of the backend framework.

The one difference from synchronous backends: the ADK agent does not process the MCP tool result within the same run. If the agent needs to reason about the result, the client must provide it as a `ToolMessage` in a subsequent run — the same pattern ADK uses for all client-side tools. See [TOOLS.md](./TOOLS.md) for details on the multi-run execution flow.

## TypeScript Client Setup

```typescript
import { ADKAgent } from "@ag-ui/adk";
import { MCPAppsMiddleware } from "@ag-ui/mcp-apps-middleware";

// 1. Create the ADK agent pointing to your backend
const agent = new ADKAgent({
  url: "http://localhost:8000/chat",
});

// 2. Attach MCP Apps middleware — MCP tools are discovered and injected automatically
agent.use(
  new MCPAppsMiddleware({
    mcpServers: [
      {
        type: "http",
        url: "http://localhost:3001/mcp",
        serverId: "my-mcp-server",
      },
    ],
  })
);
```

No changes are required on the Python side. Your ADK agent just needs `AGUIToolset()` in its tools list (which you likely already have), and the MCP tools will appear alongside your other client tools.

## Python Backend (No Changes Needed)

Your existing ADK agent setup works as-is:

```python
from google.adk.agents import LlmAgent
from ag_ui_adk import ADKAgent, AGUIToolset, add_adk_fastapi_endpoint
from fastapi import FastAPI

agent = LlmAgent(
    name="assistant",
    model="gemini-2.5-flash",
    instruction="You are a helpful assistant.",
    tools=[
        AGUIToolset(),  # MCP tools injected by the middleware appear here automatically
    ],
)

adk_agent = ADKAgent(
    adk_agent=agent,
    app_name="my_app",
    user_id="user123",
)

app = FastAPI()
add_adk_fastapi_endpoint(app, adk_agent, path="/chat")
```

## Important: `tool_filter` Can Block MCP Tools

If your `AGUIToolset` uses a `tool_filter`, MCP tools injected by the middleware will be subject to that filter. Since MCP tool names are defined by the MCP server (not your application), they are unlikely to appear in an explicit allowlist.

This will silently prevent the ADK agent from seeing MCP tools:

```python
# These filters will block MCP tools because their names won't match
AGUIToolset(tool_filter=['sayHello', 'calculate'])  # allowlist - MCP tools excluded
AGUIToolset(tool_filter=lambda tool, **_: tool.name.startswith('my_'))  # predicate - MCP tools excluded
```

To support MCP tools alongside a `tool_filter`, either:

1. **Use `AGUIToolset()` without a filter** (simplest — all client tools including MCP tools pass through):

    ```python
    tools=[AGUIToolset()]
    ```

2. **Add MCP tool names to your allowlist** (if you know them ahead of time):

    ```python
    tools=[AGUIToolset(tool_filter=['sayHello', 'weather_dashboard'])]
    ```

3. **Use a predicate that accepts MCP tools** (e.g., by checking the tool description for the UI resource marker that the middleware injects):

    ```python
    tools=[
        AGUIToolset(
            tool_filter=lambda tool, **_: (
                tool.name in ['sayHello', 'calculate']
                or '[UI Resource:' in (tool.description or '')
            )
        )
    ]
    ```

If you are using `tool_filter` and MCP tools are not being called by the agent, this is the most likely cause.

## Handling MCP Tool Results Across Runs

For use cases where the agent only needs to trigger a UI widget (e.g., rendering a dashboard), a single run is sufficient — the `ACTIVITY_SNAPSHOT` handles the frontend rendering.

If the agent needs to incorporate the MCP tool result into its response, feed the result back in a subsequent run. See the multi-run pattern in [FRAMEWORK_COMPATIBILITY.md](../../../middlewares/mcp-apps-middleware/FRAMEWORK_COMPATIBILITY.md#multi-run-pattern-adk).

## Related Documentation

- [FRAMEWORK_COMPATIBILITY.md](../../../middlewares/mcp-apps-middleware/FRAMEWORK_COMPATIBILITY.md) — Full comparison of middleware behavior across frameworks
- [TOOLS.md](./TOOLS.md) — ADK tool support and the long-running execution flow
- [MCP Apps Middleware README](../../../middlewares/mcp-apps-middleware/README.md) — Middleware configuration and API reference
