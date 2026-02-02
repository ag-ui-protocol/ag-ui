# @ag-ui/mastra

Implementation of the AG-UI protocol for Mastra.

Connects Mastra agents (local and remote) to frontend applications via the AG-UI protocol. Supports streaming responses, memory management, and tool execution.

## Installation

Install the `@ag-ui/mastra` package:

```bash
# npm
npm install @ag-ui/mastra
# pnpm
pnpm add @ag-ui/mastra
# yarn
yarn add @ag-ui/mastra
```

Install the required peer dependencies:

```bash
npm install @mastra/client-js @mastra/core @ag-ui/core @ag-ui/client @copilotkit/runtime
```

## Usage

```ts
import { MastraAgent } from "@ag-ui/mastra";
import { mastra } from "./mastra"; // Your Mastra instance

// Create an AG-UI compatible agent
const agent = new MastraAgent({
  agent: mastra.getAgent("weather-agent"),
  resourceId: "user-123",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "What's the weather like?" }],
});
```

## Features

- **Local & remote agents** – Works with in-process and network Mastra agents
- **Memory integration** – Automatic thread and working memory management
- **Tool streaming** – Real-time tool call execution and results
- **State management** – Bidirectional state synchronization

## To run the example server in the dojo

```bash
cd integrations/mastra/typescript/examples
pnpm install
pnpm run dev
```
