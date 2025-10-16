# @ag-ui/langgraph

Implementation of the AG-UI protocol for LangGraph.

Connects LangGraph graphs to frontend applications via the AG-UI protocol. Supports both local TypeScript graphs and remote LangGraph Cloud deployments with full state management and interrupt handling.

## Installation

```bash
npm install @ag-ui/langgraph
pnpm add @ag-ui/langgraph
yarn add @ag-ui/langgraph
```

## Usage

```ts
import { LangGraphAgent } from "@ag-ui/langgraph";

// Create an AG-UI compatible agent
const agent = new LangGraphAgent({
  graphId: "my-graph",
  deploymentUrl: "https://your-langgraph-deployment.com",
  langsmithApiKey: "your-api-key",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Start the workflow" }],
});
```

## Features

- **Cloud & local support** – Works with LangGraph Cloud and local graph instances
- **State management** – Bidirectional state synchronization with graph nodes
- **Interrupt handling** – Human-in-the-loop workflow support
- **Step tracking** – Real-time node execution progress

## To run the example server in the dojo

```bash
cd integrations/langgraph/typescript/examples
langgraph dev
```
