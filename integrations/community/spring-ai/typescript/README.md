# @ag-ui/spring-ai

Implementation of the AG-UI protocol for Spring AI.

Connects Spring AI to frontend applications via the AG-UI protocol. Provides HTTP connectivity to Spring servers with support for RAG pipelines and workflow orchestration.

## Installation

```bash
npm install @ag-ui/spring-ai
pnpm add @ag-ui/spring-ai
yarn add @ag-ui/spring-ai
```

## Usage

```ts
import { SpringAiAgent } from "@ag-ui/spring-ai";

// Create an AG-UI compatible agent
const agent = new SpringAiAgent({
  url: "http://localhost:9000/agentic_chat",
  headers: { "Content-Type": "application/json" },
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Query my documents" }],
});
```

## Features

- **HTTP connectivity** – Connect to LlamaIndex FastAPI servers
- **Workflow support** – Full integration with LlamaIndex workflow orchestration
- **RAG capabilities** – Document retrieval and reasoning workflows
- **Python integration** – Complete FastAPI server implementation included

## To run the example server in the dojo

```bash
cd integrations/llama-index/python/examples
uv sync && uv run dev
```
