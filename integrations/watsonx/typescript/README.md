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

Authentication is handled via IBM Cloud IAM. Pass an `apiKey` and the adapter exchanges it for a bearer token automatically, refreshing before expiry.
