# @ag-ui/cloudflare

Implementation of the AG-UI protocol for Cloudflare.

Connects Cloudflare Workers AI models and Agents SDK to frontend applications via the AG-UI protocol. Supports streaming responses, tool calling, edge deployment, and stateful agent patterns with built-in state management and SQL.

## Installation

```bash
npm install @ag-ui/cloudflare
pnpm add @ag-ui/cloudflare
yarn add @ag-ui/cloudflare
```

## Usage

### Workers AI Models

```ts
import { CloudflareAgent } from "@ag-ui/cloudflare";

// Create an AG-UI compatible agent
const agent = new CloudflareAgent({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  systemPrompt: "You are a helpful assistant.",
});

// Run with streaming
const observable = agent.run({
  threadId: "thread-1",
  runId: "run-1",
  messages: [{ role: "user", content: "Hello!" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

observable.subscribe({
  next: (event) => console.log(event.type, event),
  error: (error) => console.error(error),
  complete: () => console.log("Complete"),
});
```

### With Tool Calling

```ts
import { CloudflareAgent, supportsToolCalling } from "@ag-ui/cloudflare";

const tools = [
  {
    name: "get_weather",
    description: "Get current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
];

const agent = new CloudflareAgent({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // Supports tools
});

const observable = agent.run({
  threadId: "weather-1",
  runId: "run-1",
  messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
  tools,
  context: [],
  state: {},
  forwardedProps: {},
});
```

### CopilotKit Integration

```ts
import { CloudflareAGUIAdapter } from "@ag-ui/cloudflare";
import { CopilotRuntime } from "@copilotkit/runtime";

const adapter = new CloudflareAGUIAdapter({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
});

// Use as CopilotKit service adapter
const runtime = new CopilotRuntime();
const response = await runtime.process({
  messages,
  adapter,
});
```

### Cloudflare Agents SDK

```ts
import { Agent } from "agents";
import { createAgentsSDKAdapter } from "@ag-ui/cloudflare";

export class ChatAgent extends Agent {
  async *onChatMessage(message: string) {
    // Built-in state management
    await this.setState({ thinking: true });

    // Built-in SQL database
    await this.sql`INSERT INTO history VALUES (${message})`;

    // Stream response
    yield "Processing: " + message;
  }
}

// Wrap with AG-UI protocol
const agent = new ChatAgent(state, env);
const adapter = createAgentsSDKAdapter(agent, { syncState: true });

// Emits AG-UI events
for await (const event of adapter.execute(messages)) {
  console.log(event.type, event);
}
```

## Available Models

### Tool-Calling Capable

- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` – Llama 3.3 70B (fast, function calling)
- `@cf/meta/llama-4-scout-17b-16e-instruct` – Llama 4 Scout 17B (latest, function calling)
- `@cf/mistralai/mistral-small-3.1-24b-instruct` – Mistral Small 24B (function calling)
- `@cf/nousresearch/hermes-2-pro-mistral-7b` – Hermes 2 Pro 7B (function calling)

### General Purpose

- `@cf/meta/llama-3.1-8b-instruct` – Llama 3.1 8B (fast, general purpose)
- `@cf/meta/llama-3.1-70b-instruct` – Llama 3.1 70B (large, general purpose)
- `@cf/mistral/mistral-7b-instruct-v0.2` – Mistral 7B (fast, general purpose)

Check model capabilities:

```ts
import { supportsToolCalling } from "@ag-ui/cloudflare";

if (supportsToolCalling(model)) {
  console.log("Model supports tool calling");
}
```

## Features

- **Workers AI integration** – Access to LLM models running on Cloudflare's edge network
- **Tool calling support** – Function calling with automatic capability detection and validation
- **Streaming responses** – Real-time SSE streaming with proper tool call accumulation
- **CopilotKit compatible** – Drop-in replacement for CopilotKit service adapters
- **Retry logic** – Exponential backoff with jitter for failed requests
- **Type safe** – Full TypeScript support with Zod validation
- **Input validation** – Configuration validated at instantiation with clear error messages
- **Enhanced logging** – Structured error logs with full context (threadId, runId, stack traces)
- **Agents SDK support** – Integration with Cloudflare Agents SDK for stateful agents
- **AI Gateway** – Optional routing through Cloudflare AI Gateway for caching and analytics

## Configuration

### Environment Variables

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

### Agent Options

```ts
interface CloudflareAgentConfig {
  accountId: string; // Required: Cloudflare account ID
  apiToken: string; // Required: Cloudflare API token
  model?: string; // Optional: Defaults to Llama 3.1 8B
  systemPrompt?: string; // Optional: System instructions
  streamingEnabled?: boolean; // Optional: Defaults to true
  baseURL?: string; // Optional: Custom API endpoint
  gatewayId?: string; // Optional: AI Gateway ID for routing
}
```

### With AI Gateway

```ts
const agent = new CloudflareAgent({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  gatewayId: "my-gateway-id", // Route through AI Gateway
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
});
```

### Custom Retry Configuration

```ts
import { CloudflareAIClient } from "@ag-ui/cloudflare";

const client = new CloudflareAIClient(
  {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  },
  {
    maxRetries: 5, // Retry up to 5 times
    baseDelay: 2000, // Start with 2 second delay
    maxDelay: 30000, // Max 30 second delay
    retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  }
);
```

## Express.js Integration

```ts
import express from "express";
import { CloudflareAgent } from "@ag-ui/cloudflare";

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
  const { messages, threadId } = req.body;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const agent = new CloudflareAgent({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  });

  const observable = agent.run({
    threadId: threadId || `thread-${Date.now()}`,
    runId: `run-${Date.now()}`,
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });

  const subscription = observable.subscribe({
    next: (event) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    error: (error) => {
      res.write(`event: ERROR\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    },
    complete: () => res.end(),
  });

  req.on("close", () => subscription.unsubscribe());
});

app.listen(3000);
```

## Cloudflare Workers Deployment

```ts
import { CloudflareAgent } from "@ag-ui/cloudflare";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { messages } = await request.json();

    const agent = new CloudflareAgent({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const observable = agent.run({
        threadId: `thread-${Date.now()}`,
        runId: `run-${Date.now()}`,
        messages,
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      });

      observable.subscribe({
        next: async (event) => {
          await writer.write(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          );
        },
        complete: async () => await writer.close(),
      });
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  },
};
```

## Error Handling

Configuration is validated automatically:

```ts
try {
  const agent = new CloudflareAgent({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  });
} catch (error) {
  // Configuration validation errors
  console.error("Invalid configuration:", error.message);
  // Example: "Invalid accountId: Account ID is required"
}
```

Enhanced error logging provides full context:

```ts
observable.subscribe({
  error: (error) => {
    // Error logs automatically include:
    // - threadId, runId
    // - Stack trace
    // - Timestamp
    console.error("Error:", error);
  },
});
```

## Tool Capability Warnings

The agent automatically validates model capabilities:

```ts
const agent = new CloudflareAgent({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  model: "@cf/meta/llama-3.1-8b-instruct", // Doesn't support tools
});

// When tools are provided, you'll see a warning:
// [CloudflareAgent] Model "..." does not support tool calling.
// Tools will be ignored. Use a compatible model like: ...
```

## Migration from OpenAI

```ts
// Before (OpenAI)
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// After (Cloudflare)
import { CloudflareAgent } from "@ag-ui/cloudflare";
const agent = new CloudflareAgent({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
});
```

## Running Examples in the AG-UI Dojo

The Cloudflare integration includes 6 example agents that run in the AG-UI Dojo demo viewer.

### Quick Start (Run All Demos)

From the repository root:

```bash
cd apps/dojo
pnpm run-everything
```

This starts all integrations including Cloudflare on `http://localhost:4114` and the dojo on `http://localhost:9999`.

### Run Only Cloudflare + Dojo

To run just the Cloudflare demos:

```bash
cd apps/dojo
node ./scripts/prep-dojo-everything.js --only cloudflare,dojo
node ./scripts/run-dojo-everything.js --only cloudflare,dojo
```

Then visit `http://localhost:9999` and select **Cloudflare Workers AI** from the integration menu.

### Available Demo Agents

- **agentic_chat** – Basic conversational agent
- **agentic_generative_ui** – Progressive state updates with UI generation
- **backend_tool_rendering** – Backend-generated UI components
- **human_in_the_loop** – Human approval workflow
- **shared_state** – Persistent state management with todos
- **tool_based_generative_ui** – Frontend tool rendering (haiku generation)

### Prerequisites

1. Set up your Cloudflare credentials in `integrations/cloudflare/typescript/examples/.env`:
   ```bash
   CLOUDFLARE_ACCOUNT_ID=your_account_id
   CLOUDFLARE_API_TOKEN=your_api_token
   ```

2. Install dependencies (done automatically by `prep-dojo-everything.js`)

## API Reference

### CloudflareAgent

Extends `AbstractAgent` from `@ag-ui/client`.

```ts
class CloudflareAgent {
  constructor(config: CloudflareAgentConfig);
  run(input: RunAgentInput): Observable<BaseEvent>;
}
```

### CloudflareAGUIAdapter

Implements `AGUIProtocol` and `CopilotServiceAdapter`.

```ts
class CloudflareAGUIAdapter {
  constructor(options: CloudflareAGUIAdapterOptions);
  execute(
    messages: CloudflareMessage[],
    context?: Record<string, any>
  ): AsyncGenerator<BaseEvent>;
  process(
    request: CopilotRuntimeChatCompletionRequest
  ): Promise<CopilotRuntimeChatCompletionResponse>;
}
```

### CloudflareAIClient

Low-level client for Cloudflare Workers AI API.

```ts
class CloudflareAIClient {
  constructor(config: CloudflareAIConfig, retryOptions?: RetryOptions);
  complete(options: CloudflareCompletionOptions): Promise<CloudflareMessage>;
  streamComplete(
    options: CloudflareCompletionOptions
  ): AsyncGenerator<CloudflareStreamChunk>;
  listModels(): Promise<string[]>;
  getModelCapabilities(model: string): ModelCapabilities;
}
```

## License

Apache-2.0
