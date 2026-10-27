# @ag-ui/watsonx

AG-UI integration for [IBM watsonx orchestrate](https://www.ibm.com/products/watsonx-orchestrate) agents.

## Installation

```bash
npm install @ag-ui/watsonx
```

## Usage

### TypeScript (Direct — No Python Server Required)

`WatsonxAgent` extends `AbstractAgent` and calls the watsonx orchestrate API directly, translating OpenAI-compatible SSE deltas into AG-UI events. It handles IAM token exchange and auto-refresh.

```typescript
import { WatsonxAgent } from "@ag-ui/watsonx";
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";

const runtime = new CopilotRuntime({
  agents: {
    my_agent: new WatsonxAgent({
      region: "au-syd",
      instanceId: "your-instance-id",
      agentId: "your-watsonx-agent-id",
      apiKey: process.env.WATSONX_API_KEY,
    }),
  },
});

export const POST = async (req: NextRequest) => {
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
};
```

### Python (Server Adapter)

If you prefer running a Python intermediary server:

```bash
pip install ag_ui_watsonx
```

```python
from ag_ui_watsonx import WatsonxAgent, create_watsonx_app

agent = WatsonxAgent(
    region="au-syd",
    instance_id="your-instance-id",
    agent_id="your-watsonx-agent-id",
    api_key="YOUR_API_KEY",
)

app = create_watsonx_app(agent)

# Run with: uvicorn main:app --port 8000
```

Then point a standard `HttpAgent` at `http://localhost:8000/` from your CopilotKit runtime.

## Configuration

### TypeScript

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `region` | `string` | Yes | IBM Cloud region (e.g., `au-syd`, `us-south`, `eu-de`) |
| `instanceId` | `string` | Yes | watsonx orchestrate instance ID |
| `agentId` | `string` | Yes | The watsonx agent ID |
| `apiKey` | `string` | One of | IBM Cloud API key — tokens are exchanged and refreshed automatically |
| `bearerToken` | `string` | One of | Pre-exchanged IAM bearer token (expires ~1 hour) |
| `baseUrl` | `string` | No | Instance URL to call instead of the one derived from `region` and `instanceId` (a private endpoint, or an OpenAI-compatible mock in tests) |

### Python

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `region` | `str` | Yes | IBM Cloud region |
| `instance_id` | `str` | Yes | watsonx orchestrate instance ID |
| `agent_id` | `str` | Yes | The watsonx agent ID |
| `api_key` | `str` | One of | IBM Cloud API key — auto-refreshed |
| `bearer_token` | `str` | One of | Pre-exchanged IAM bearer token |

## How It Works

IBM watsonx orchestrate exposes an OpenAI-compatible chat completions endpoint with SSE streaming at:

```
https://api.{region}.watson-orchestrate.cloud.ibm.com/instances/{instanceId}/v1/orchestrate/{agentId}/chat/completions
```

This adapter translates between that format and the AG-UI event protocol:

- `choices[0].delta.content` → `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END`
- `choices[0].delta.tool_calls` → `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`
- `X-IBM-THREAD-ID` header is mapped from AG-UI's `threadId` for conversation continuity
- `RUN_STARTED` declares the AG-UI protocol version (`protocolVersion: "1.0"`)
- Content-part messages are sent as their text parts; image, audio, video and document parts are dropped with a warning, since watsonx orchestrate receives a text prompt

Authentication is handled via IBM Cloud IAM. Pass an `apiKey` and the adapter exchanges it for a bearer token automatically, refreshing before expiry.

## Tool Responses: `WatsonxRunsAgent`

The chat completions endpoint only returns the agent's text. `WatsonxRunsAgent` calls the watsonx orchestrate runs API instead, which also streams each step of the run, including the raw responses of the agent's tools:

```
POST https://api.{region}.watson-orchestrate.cloud.ibm.com/instances/{instanceId}/v1/orchestrate/runs/stream
```

Use it when your UI needs the data behind the answer, for example to fill a table or a chart from a tool's JSON instead of parsing the agent's Markdown.

```typescript
import { WatsonxRunsAgent } from "@ag-ui/watsonx";

const agent = new WatsonxRunsAgent({
  region: "eu-de",
  instanceId: "your-instance-id",
  agentId: "your-watsonx-agent-id",
  apiKey: process.env.WATSONX_API_KEY,
  // Optional: turn tool responses into AG-UI state.
  onToolResult: ({ name, content }, { state }) => {
    if (!name.endsWith("search_orders_tool")) return undefined;
    return { ...state, orders: JSON.parse(content) };
  },
});
```

### Configuration

`WatsonxRunsAgent` takes the same `region`, `instanceId`, `agentId`, `apiKey`, `bearerToken` and `baseUrl` options as `WatsonxAgent`, plus:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `environmentId` | `string` | No | Agent environment (draft or live) |
| `timeoutMs` | `number` | No | Maximum duration of a run, in milliseconds (default `120000`) |
| `onToolResult` | `(result, { state, input }) => State \| undefined` | No | Called for each tool response. Return a new state to emit it as a `STATE_SNAPSHOT`, or `undefined` to leave the state unchanged |
| `threadStore` | `WatsonxThreadStore` | No | Where the watsonx thread of each AG-UI thread is kept (default: in memory, 5,000 threads) |

### How It Works

- `message.delta` → `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` (`message.created` is used when nothing was streamed)
- `run.step.delta` tool calls → `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`, once per call
- `run.step.delta` tool responses → `TOOL_CALL_RESULT`, then `STATE_SNAPSHOT` if `onToolResult` returns a state. A response that arrives before its call (as with collaborator agents) waits for the call record, so its arguments still reach `TOOL_CALL_ARGS` and `onToolResult`
- `run.failed`, `run.cancelled`, `run.expired`, `error` → `RUN_ERROR`
- Every watsonx event is also emitted as a `RAW` event (`source: "watsonx"`)

Tool calls run on watsonx: each one gets a `TOOL_CALL_RESULT`, so clients do not try to execute them, and frontend tools (`input.tools`) are not forwarded.

watsonx keeps the conversation in its own thread, so only the last user message is sent. The watsonx thread is created on the first turn and reused for the following turns of the same AG-UI thread. If watsonx no longer knows it, the run is retried once in a new thread. The default store is in memory: pass a `threadStore` with `get`, `set` and `delete` (sync or async) to keep conversations across restarts or server instances. Stored threads are keyed by instance, environment, agent and AG-UI thread, so one store can serve several configurations.

The adapter does not serialize runs. If two first turns of the same AG-UI thread run at once, each starts its own watsonx thread and the one stored last is kept for later turns. Send one run at a time per AG-UI thread to keep a single conversation.

`forwardedProps` are sent in the request body as is (for example `context`), except for `message`, `agent_id`, `environment_id` and `thread_id`, which the adapter sets.
