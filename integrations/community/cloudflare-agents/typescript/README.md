# @ag-ui/cloudflare-agents

AG-UI connector for Cloudflare Agents SDK.

Connects Cloudflare Workers running the Agents SDK to frontend applications via the AG-UI protocol.

## Installation

```bash
npm install @ag-ui/cloudflare-agents
pnpm add @ag-ui/cloudflare-agents
yarn add @ag-ui/cloudflare-agents
```

## Usage

```typescript
import { CloudflareAgentsAgent } from "@ag-ui/cloudflare-agents";

// Create an AG-UI compatible agent
const agent = new CloudflareAgentsAgent({
  url: "https://your-worker.workers.dev/agents/my-agent/session",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Hello!" }],
});
```

## Features

- **WebSocket connectivity** – Real-time streaming via WebSocket
- **Minimal footprint** – Simple, focused connector
- **AG-UI compliant** – Full AG-UI protocol support
- **Cloudflare Workers** – Optimized for Cloudflare's edge runtime

## Example Server

See `examples/worker/` for a complete Cloudflare Worker implementation that works with this connector.

```bash
cd examples/worker
pnpm install
pnpm dev
```

## Event Mapping

Cloudflare Agent events are automatically transformed to AG-UI events:

| Cloudflare Event | AG-UI Event |
|-----------------|-------------|
| `RUN_STARTED` | `RUN_STARTED` |
| `TEXT_MESSAGE_START` | `TEXT_MESSAGE_START` |
| `TEXT_MESSAGE_CONTENT` | `TEXT_MESSAGE_CONTENT` |
| `TEXT_MESSAGE_END` | `TEXT_MESSAGE_END` |
| `RUN_FINISHED` | `RUN_FINISHED` |
