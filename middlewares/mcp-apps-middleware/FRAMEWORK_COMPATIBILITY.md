# MCPAppsMiddleware Framework Compatibility

MCPAppsMiddleware is a framework-agnostic TypeScript middleware. It works with any AG-UI backend — ADK, LangGraph, Mastra, and others — because it operates at the AG-UI protocol level, not within the backend framework itself.

However, backend frameworks handle tool execution differently, and this affects how the agent interacts with MCP tool results. This document explains those differences.

## How the Middleware Works

The middleware sits on the **TypeScript client side**, wrapping the agent that connects to your backend:

```
Frontend → MCPAppsMiddleware (TS) → HttpAgent → Backend Server (ADK, LangGraph, etc.)
```

On each run, it performs the following steps:

1. **Discovers** UI-enabled tools from configured MCP servers (tools with `_meta["ui/resourceUri"]`)
2. **Injects** those tools into `RunAgentInput.tools` before forwarding to the backend
3. **Tracks** message state as the backend streams events, using `runNextWithState()`
4. **Holds back** the `RUN_FINISHED` event when the stream ends
5. **Finds pending tool calls** — tool calls in assistant messages that have no corresponding `role: "tool"` result message
6. **Executes** any pending MCP UI tool calls server-side against the MCP server
7. **Emits** `TOOL_CALL_RESULT` and `ACTIVITY_SNAPSHOT` (with `resourceUri` for frontend rendering)
8. **Releases** the `RUN_FINISHED` event

Because this logic operates entirely on the AG-UI event stream, it works regardless of which backend framework produced those events.

## LangGraph (Synchronous Tool Execution)

LangGraph executes tools **within the agent's run loop**. When the LLM decides to call a tool, LangGraph can execute it and feed the result back to the LLM in the same run.

For MCP UI tools injected by the middleware:

- The LLM calls the MCP tool during its run
- LangGraph does not know how to execute the MCP tool, so the tool call remains pending (no result message)
- The middleware intercepts the pending call after the run finishes
- The middleware executes the tool against the MCP server and emits `TOOL_CALL_RESULT` + `ACTIVITY_SNAPSHOT`
- The frontend renders the MCP app UI using the `resourceUri` from the activity snapshot

The agent has already completed its reasoning by this point, but the UI rendering works correctly because the `ACTIVITY_SNAPSHOT` event is what drives the frontend display.

## ADK (Long-Running Tool Execution)

ADK treats **all client-supplied tools as long-running** (fire-and-forget). This is an architectural decision that supports human-in-the-loop workflows where the agent pauses and waits for the client to provide a tool result in a subsequent run.

When the LLM calls an MCP tool through ADK:

1. ADK's `ClientProxyTool` emits `TOOL_CALL_START`, `TOOL_CALL_ARGS`, and `TOOL_CALL_END` events
2. The tool returns `None` immediately — ADK does not wait for a result
3. ADK finishes the run
4. The middleware holds back `RUN_FINISHED`, finds the pending tool call (no result message exists), and executes it against the MCP server
5. The middleware emits `TOOL_CALL_RESULT` + `ACTIVITY_SNAPSHOT`
6. The frontend renders the MCP app UI

**The UI rendering works the same way as with LangGraph.** The `ACTIVITY_SNAPSHOT` event with `resourceUri` is emitted in both cases, and the frontend handles it identically.

### What differs with ADK

The ADK agent does **not** process the MCP tool result within the same run. Because ADK uses the long-running tool pattern, the agent's execution has already completed by the time the middleware executes the MCP tool.

If you need the agent to reason about the MCP tool result (e.g., summarize what the tool returned), you must provide the result as a `ToolMessage` in a subsequent run. See [Multi-Run Pattern](#multi-run-pattern-adk) below.

For pure UI rendering use cases — where the MCP tool produces an interactive widget and the agent does not need to react to the result — this difference is irrelevant. The UI renders correctly in a single run.

## Comparison

| Aspect | LangGraph | ADK |
|--------|-----------|-----|
| Tool execution model | Synchronous (within run) | Long-running (fire-and-forget) |
| MCP tool interception by middleware | Yes | Yes |
| `TOOL_CALL_RESULT` emitted | Yes | Yes |
| `ACTIVITY_SNAPSHOT` emitted | Yes | Yes |
| Frontend UI rendering | Works | Works |
| Agent processes tool result in same run | No (run already finished) | No (requires subsequent run) |

## Client-Side Setup

### With ADK

```typescript
import { ADKAgent } from "@ag-ui/adk";
import { MCPAppsMiddleware } from "@ag-ui/mcp-apps-middleware";

const agent = new ADKAgent({
  url: "http://localhost:8000/chat",
});

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

### With LangGraph

```typescript
import { HttpAgent } from "@ag-ui/client";
import { MCPAppsMiddleware } from "@ag-ui/mcp-apps-middleware";

const agent = new HttpAgent({
  url: "http://localhost:8000/langgraph",
});

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

The middleware setup is identical — only the agent class and backend URL change.

## Multi-Run Pattern (ADK)

If the ADK agent needs to reason about an MCP tool result, include the result as a `ToolMessage` in the next run:

```typescript
import { RunAgentInput } from "@ag-ui/core";

// First run: agent calls MCP tool, middleware executes it and emits events
const toolResults: Array<{ toolCallId: string; content: string }> = [];

agent.run(firstInput).subscribe({
  next: (event) => {
    if (event.type === "TOOL_CALL_RESULT") {
      toolResults.push({
        toolCallId: event.toolCallId,
        content: event.content,
      });
    }
    if (event.type === "ACTIVITY_SNAPSHOT") {
      // Render the MCP app UI
    }
  },
  complete: () => {
    if (toolResults.length > 0) {
      // Second run: feed tool results back so the agent can reason about them
      const resumeInput: RunAgentInput = {
        threadId: firstInput.threadId,
        runId: "run-2",
        messages: [
          ...firstInput.messages,
          // Include tool results
          ...toolResults.map((tr, i) => ({
            id: `tool-result-${i}`,
            role: "tool" as const,
            content: tr.content,
            toolCallId: tr.toolCallId,
          })),
        ],
        tools: firstInput.tools,
        context: [],
        state: {},
        forwardedProps: {},
      };

      agent.run(resumeInput).subscribe({ /* handle response */ });
    }
  },
});
```

This multi-run pattern is consistent with how ADK handles all client-side tools. See the [ADK TOOLS.md](../../integrations/adk-middleware/python/TOOLS.md) for more detail on the long-running tool execution flow.
