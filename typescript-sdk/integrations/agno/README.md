# @ag-ui/agno

AG-UI integration for **Agno** - Multi-Agent Systems framework with memory, knowledge and reasoning.

Connects Agno agents to frontend applications via the AG-UI protocol using HTTP communication.

## Installation

```bash
npm install @ag-ui/agno
pnpm add @ag-ui/agno
yarn add @ag-ui/agno
```

## Usage

```ts
import { AgnoAgent } from "@ag-ui/agno";

// Create an AG-UI compatible agent
const agent = new AgnoAgent({
  url: "https://your-agno-server.com/agent",
  headers: { Authorization: "Bearer your-token" },
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Hello from Agno!" }],
});
```

## Features

- **HTTP connectivity** – Direct connection to Agno agent servers
- **Multi-agent support** – Works with Agno's multi-agent system architecture
- **Streaming responses** – Real-time communication with full AG-UI event support
