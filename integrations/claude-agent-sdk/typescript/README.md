# @ag-ui/claude-agent-sdk

Implementation of the AG-UI protocol for the Anthropic Claude Agent SDK (TypeScript).

Provides a complete TypeScript integration for Claude agents with the AG-UI protocol, including streaming responses and comprehensive event handling.

## Installation

```bash
npm install @ag-ui/claude-agent-sdk @anthropic-ai/claude-agent-sdk zod
```

## Usage

```typescript
import { ClaudeAgentAdapter } from "@ag-ui/claude-agent-sdk";

const adapter = new ClaudeAgentAdapter({
  model: "claude-haiku-4-5",
  permissionMode: "default",
});

// Run with AG-UI
const events$ = adapter.run(input);
events$.subscribe({
  next: (event) => console.log(event),
  complete: () => console.log("Done"),
});
```

## Features

- **Native Claude SDK integration** – Direct support for Claude Agent SDK with streaming responses
- **Observable pattern** – RxJS Observable for event streaming
- **Advanced event handling** – Comprehensive support for all AG-UI events including thinking, tool calls, and state updates
- **Custom tools via MCP** – Define custom tools using Claude SDK's tool() function
- **Multi-turn conversations** – Session continuity via resume option

## To run the dojo examples

```bash
# Set API key
export ANTHROPIC_API_KEY=your-key

# Start Dojo
cd ag-ui
pnpm dev
```

Visit **http://localhost:3000** and select "Claude Agent SDK"

## Links

- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [AG-UI Documentation](https://docs.ag-ui.com/)
