# @ag-ui/vercel-ai-sdk

Implementation of the AG-UI protocol for Vercel AI SDK.

Connects Vercel AI SDK models and tools to frontend applications via the AG-UI protocol. Provides native TypeScript integration with streamText, tool execution, and multi-step workflows.

## Installation

```bash
npm install @ag-ui/vercel-ai-sdk
pnpm add @ag-ui/vercel-ai-sdk
yarn add @ag-ui/vercel-ai-sdk
```

## Usage

```ts
import { VercelAISDKAgent } from "@ag-ui/vercel-ai-sdk";
import { openai } from "ai/openai";

// Create an AG-UI compatible agent
const agent = new VercelAISDKAgent({
  model: openai("gpt-4"),
  maxSteps: 3,
  toolChoice: "auto",
});

// Run with streaming
const result = await agent.runAgent({
  messages: [{ role: "user", content: "Help me with a task" }],
});
```

## Features

- **Native TypeScript** – Direct integration with Vercel AI SDK models
- **Streaming support** – Real-time text and tool call streaming
- **Multi-step workflows** – Automatic tool execution chains
- **Model flexibility** – Works with OpenAI, Anthropic, and other providers

## To run the example server in the dojo

```bash
# Use directly in TypeScript applications
# No separate server needed
```
