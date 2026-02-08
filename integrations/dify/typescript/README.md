# AG-UI Dify Integration

This package provides integration between AG-UI and Dify, allowing you to use Dify's conversational AI agents with AG-UI's agentic chat framework.

## Installation

```bash
pnpm add @ag-ui/dify
```

## Supported Features

- ✅ **Agentic Chat** - Real-time streaming conversations with Dify workflows
- ❌ Tool-based Generative UI - Not supported (Dify API doesn't expose tool execution details)

## Usage

```typescript
import { DifyAgent } from "@ag-ui/dify";

// Create a Dify agent
const agent = new DifyAgent({
  apiKey: "your-dify-api-key",
  baseUrl: "https://api.dify.ai/v1", // optional
});

// Stream messages
const stream = agent.stream({
  messages: [
    { role: "user", content: "Hello, how can you help?" }
  ],
  threadId: "thread-1",
  runId: "run-1",
});

for await (const event of stream) {
  console.log(event);
}
```

## Configuration

Set the following environment variables:

- `DIFY_API_KEY`: Your Dify API key (required)
- `DIFY_API_BASE_URL`: Dify API base URL (optional, defaults to "https://api.dify.ai/v1")

## How It Works

The integration streams events from Dify's workflow execution:

1. **Workflow Events** - Captures workflow start/end and node execution progress
2. **Message Streaming** - Streams the final text response incrementally
3. **Event Translation** - Converts Dify events to AG-UI event format
4. **State Management** - Maintains conversation context via conversation_id

## Limitations

### Tool Execution Visibility

Dify's API does not expose tool/function execution details in the streaming or detail APIs. While Dify supports workflow nodes (including tool nodes), the execution trace is not accessible for real-time tool tracking.

**What's available:**
- ✅ Workflow progress (nodes starting/finishing)
- ✅ Final outputs
- ✅ Token usage and timing

**What's NOT available:**
- ❌ Tool call events
- ❌ Function execution details
- ❌ Intermediate step results
- ❌ Tool selection/invocation data

This limitation is at the API level, not the integration.

## API Reference

### DifyAgent

The main class for integrating Dify with AG-UI.

#### Constructor

```typescript
constructor(config: DifyClientConfig)
```

Parameters:
- `config`: Configuration object
  - `apiKey`: Your Dify API key
  - `baseUrl`: (optional) Dify API base URL, defaults to "https://api.dify.ai/v1"

#### Methods

- `stream(input: RunAgentInput)`: Streams the agent's response
  - Returns: AsyncGenerator of AG-UI events
  - Events include: RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED

## Events

The integration emits the following AG-UI events:

- `RUN_STARTED` - Workflow execution begins
- `TEXT_MESSAGE_START` - Message streaming starts
- `TEXT_MESSAGE_CONTENT` - Text chunk received (delta)
- `TEXT_MESSAGE_END` - Message streaming complete
- `RUN_FINISHED` - Workflow execution ends

## License

MIT
