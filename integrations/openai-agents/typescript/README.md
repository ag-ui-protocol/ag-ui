# @ag-ui/openai-agents

TypeScript client for connecting an AG-UI front end to a server built with
the companion Python integration
([`ag-ui-openai-agents`](../python/README.md)), which bridges the
[OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) and the
AG-UI protocol.

`OpenAIAgentsHttpAgent` is an `HttpAgent` with no added behavior: the Python
server speaks plain AG-UI over HTTP and has no extra endpoints to call.

## Installation

```bash
npm install @ag-ui/openai-agents
```

## Usage

```typescript
import { OpenAIAgentsHttpAgent } from "@ag-ui/openai-agents";

const agent = new OpenAIAgentsHttpAgent({
  url: "http://localhost:8031/agentic_chat/",
});

// Use the agent with AG-UI clients
```

## Requirements

- An `ag-ui-openai-agents` Python server running (see `../python/README.md`)
- AG-UI compatible client
