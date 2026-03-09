# @ag-ui/cloudflare-agents

AG-UI integration for Cloudflare Agents - Connect to and build agents on Cloudflare Workers.

## What This Package Provides

### 🔌 Client (Connect to Agents)

**CloudflareAgentsClient** - WebSocket client for connecting to deployed Cloudflare Agents from AG-UI applications.

```typescript
import { CloudflareAgentsClient } from "@ag-ui/cloudflare-agents";

const agent = new CloudflareAgentsClient({
  url: "wss://your-worker.workers.dev",
});

agent
  .runAgent({
    messages: [{ role: "user", content: "Hello!" }],
  })
  .subscribe({
    next: (event) => console.log(event.type, event),
  });
```

### 🔄 Adapter (Build Agents)

**AgentsToAGUIAdapter** - Convert Vercel AI SDK streams to AG-UI events in your Cloudflare Workers.

```typescript
import { AgentsToAGUIAdapter } from "@ag-ui/cloudflare-agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const adapter = new AgentsToAGUIAdapter();

const stream = streamText({
  model: openai("gpt-4"),
  messages: inputMessages,
});

for await (const event of adapter.adaptStreamToAGUI(
  stream,
  threadId,
  runId,
  inputMessages
)) {
  ws.send(JSON.stringify(event)); // Send AG-UI events to client
}
```

### 🌊 Helpers (Streaming)

**Response creators** - SSE and NDJSON streaming utilities for HTTP endpoints.

```typescript
import { createSSEResponse, createNDJSONResponse } from "@ag-ui/cloudflare-agents";
import { from } from "rxjs";

// SSE streaming
const events$ = from(adapter.adaptStreamToAGUI(stream, ...));
return createSSEResponse(events$);

// NDJSON streaming
return createNDJSONResponse(events$);
```

## Installation

```bash
npm install @ag-ui/cloudflare-agents
# or
pnpm add @ag-ui/cloudflare-agents
```

## Quick Start

### Client-Side: Connect to an Agent

```typescript
import { CloudflareAgentsClient } from "@ag-ui/cloudflare-agents";

const agent = new CloudflareAgentsClient({
  url: "wss://your-agent.workers.dev",
});

agent
  .runAgent({
    messages: [{ role: "user", content: "What's the weather?" }],
    threadId: "thread-123",
  })
  .subscribe({
    next: (event) => {
      if (event.type === "TEXT_MESSAGE_CHUNK") {
        console.log(event.delta); // Stream text chunks
      }
      if (event.type === "STATE_SNAPSHOT") {
        console.log(event.state); // State updates
      }
    },
    complete: () => console.log("Done"),
  });
```

### Server-Side: Build an Agent

Create a Cloudflare Worker that uses the adapter to emit AG-UI events:

```typescript
import { Agent } from "agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { AgentsToAGUIAdapter } from "@ag-ui/cloudflare-agents";

export class MyAgent extends Agent {
  private adapter = new AgentsToAGUIAdapter();

  async onMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const { messages } = JSON.parse(data);

    // Create AI SDK stream
    const stream = streamText({
      model: openai("gpt-4"),
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    // Convert to AG-UI events and stream to client
    for await (const event of this.adapter.adaptStreamToAGUI(
      stream,
      crypto.randomUUID(), // threadId
      crypto.randomUUID(), // runId
      messages
    )) {
      ws.send(JSON.stringify(event));
    }
  }
}
```

### With Tools

```typescript
import { z } from "zod";

const stream = streamText({
  model: openai("gpt-4"),
  messages,
  tools: {
    getWeather: {
      description: "Get current weather",
      parameters: z.object({
        location: z.string()
      }),
      execute: async ({ location }) => {
        return { temperature: 72, condition: "sunny" };
      }
    }
  }
});

for await (const event of adapter.adaptStreamToAGUI(stream, ...)) {
  ws.send(JSON.stringify(event));
}
```

### With Initial State

```typescript
for await (const event of adapter.adaptStreamToAGUI(
  stream,
  threadId,
  runId,
  messages,
  undefined, // parentRunId
  { count: 0, user: "alice" } // initial state
)) {
  ws.send(JSON.stringify(event));
}
```

## Features

- WebSocket client for connecting to deployed agents
- Adapter for converting Vercel AI SDK streams to AG-UI events
- SSE and NDJSON streaming support
- Automatic tool call event conversion
- State snapshots and deltas
- Message history snapshots
- TypeScript support

## Architecture

```
┌─────────────────────────┐
│  AG-UI Application      │
│  (Your Frontend)        │
└───────────┬─────────────┘
            │ WebSocket
            ↓
┌─────────────────────────┐
│  CloudflareAgentsClient │
│  (This Package)         │
└───────────┬─────────────┘
            │ WebSocket
            ↓
┌─────────────────────────┐
│  Cloudflare Worker      │
│  + AgentsToAGUIAdapter  │
│  (Your Deployed Agent)  │
└───────────┬─────────────┘
            │ Vercel AI SDK
            ↓
┌─────────────────────────┐
│  LLM Provider           │
│  (OpenAI, Anthropic...) │
└─────────────────────────┘
```

## Event Flow

The adapter automatically handles AG-UI event patterns:

### Lifecycle Pattern

```
RUN_STARTED → [events...] → RUN_FINISHED
                         ↘ RUN_ERROR
```

### Text Streaming Pattern

```
TEXT_MESSAGE_CHUNK (auto-expands to)
  ↓
TEXT_MESSAGE_START
  ↓
TEXT_MESSAGE_CONTENT × N
  ↓
TEXT_MESSAGE_END
```

### Tool Call Pattern

```
TOOL_CALL_CHUNK (auto-expands to)
  ↓
TOOL_CALL_START
  ↓
TOOL_CALL_ARGS × N
  ↓
TOOL_CALL_END
  ↓
TOOL_CALL_RESULT
```

### State Management Pattern

```
STATE_SNAPSHOT     (complete state)
STATE_DELTA        (incremental update via JSON Patch)
```

## Documentation

- **[docs/README.md](./docs/README.md)** - Quick start and overview
- **[docs/CLIENT.md](./docs/CLIENT.md)** - Client usage and architecture
- **[docs/ADAPTER.md](./docs/ADAPTER.md)** - Adapter patterns and examples

## API Reference

### CloudflareAgentsClient

```typescript
class CloudflareAgentsClient extends AbstractAgent {
  constructor(config: { url: string; ... });
  run(input: RunAgentInput): Observable<BaseEvent>;
  abortRun(): void;
  clone(): CloudflareAgentsClient;
}
```

### AgentsToAGUIAdapter

```typescript
class AgentsToAGUIAdapter {
  async *adaptStreamToAGUI(
    stream: StreamTextResult,
    threadId?: string,
    runId?: string,
    inputMessages?: Message[],
    parentRunId?: string,
    state?: any
  ): AsyncGenerator<BaseEvent>;
}
```

### Response Helpers

```typescript
function createSSEResponse(
  events$: Observable<BaseEvent>,
  additionalHeaders?: Record<string, string>
): Response;

function createNDJSONResponse(
  events$: Observable<BaseEvent>,
  additionalHeaders?: Record<string, string>
): Response;
```

## Requirements

- Node.js 18+ or modern browser
- Cloudflare Workers (for deployment)
- AG-UI framework

## Deployment

Deploy your Cloudflare Worker agent:

```bash
# Install Wrangler CLI
npm install -g wrangler

# Set API keys as secrets
wrangler secret put OPENAI_API_KEY

# Deploy
wrangler deploy
```

Your agent will be available at: `https://your-worker.workers.dev`
