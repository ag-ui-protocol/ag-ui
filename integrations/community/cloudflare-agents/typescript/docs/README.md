# Cloudflare Agents AG-UI Integration

AG-UI integration for Cloudflare Agents - utilities for connecting to and building agents on Cloudflare Workers.

## Quick Start

### Client: Connect to an Agent

Connect to a deployed Cloudflare Agent from your AG-UI application:

```typescript
import { CloudflareAgentsClient } from "@ag-ui/cloudflare-agents";

const agent = new CloudflareAgentsClient({
  url: "wss://your-worker.workers.dev"
});

agent.runAgent({
  messages: [{ role: "user", content: "Hello!" }]
}).subscribe({
  next: (event) => console.log(event.type, event),
  error: (err) => console.error(err),
  complete: () => console.log("Done")
});
```

### Adapter: Build an Agent

Use the adapter in your Cloudflare Worker to convert AI SDK streams to AG-UI events:

```typescript
import { Agent } from "agents";
import { AgentsToAGUIAdapter } from "@ag-ui/cloudflare-agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export class MyAgent extends Agent {
  private adapter = new AgentsToAGUIAdapter();

  async onMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const { messages } = JSON.parse(
      typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    );

    const stream = streamText({
      model: openai("gpt-4"),
      messages
    });

    for await (const event of this.adapter.adaptStreamToAGUI(
      stream,
      crypto.randomUUID(),
      crypto.randomUUID(),
      messages
    )) {
      ws.send(JSON.stringify(event));
    }
  }
}
```

## Documentation

- **[CLIENT.md](./CLIENT.md)** - Client architecture, WebSocket connection, event transformation
- **[ADAPTER.md](./ADAPTER.md)** - Adapter patterns, streaming, state management

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
│  (Your Deployed Agent)  │
└───────────┬─────────────┘
            │ Vercel AI SDK
            ↓
┌─────────────────────────┐
│  LLM Provider           │
│  (OpenAI, Anthropic...) │
└─────────────────────────┘
```

## Features

- WebSocket-based client for real-time streaming
- Adapter for Vercel AI SDK to AG-UI events
- Text streaming with automatic message chunking
- Tool call support with results
- State synchronization
- Message history snapshots
- Error handling and resilience
- TypeScript support

## Installation

```bash
npm install @ag-ui/cloudflare-agents
```

## Requirements

- Node.js 18+ or modern browser
- Cloudflare Workers (for deployment)
- AG-UI framework
