# Cloudflare AG-UI Integration

AG-UI protocol support for **Cloudflare Workers AI** and **Cloudflare Agents SDK**.

## Overview

This package (`@ag-ui/cloudflare`) provides two integration paths:

1. **Cloudflare Workers AI** - Direct AI model inference
2. **Cloudflare Agents SDK** - Stateful agent framework with Durable Objects

## Installation

```bash
npm install @ag-ui/cloudflare
```

## Deployment Options

### Option 1: Local Development (HTTP/Express)

Perfect for testing and development. Runs agents on Express server with HTTP endpoints.

**What you get:**
- ✅ Easy local testing
- ✅ HTTP-based communication
- ✅ All AG-UI protocol features
- ❌ No WebSocket state sync
- ❌ No Durable Objects persistence

**Example:** See `integrations/cloudflare/typescript/examples` (used by Dojo demo)

### Option 2: Production (Cloudflare Workers)

Full Cloudflare-native deployment with all platform features.

**What you get:**
- ✅ WebSocket state synchronization
- ✅ Durable Objects persistence
- ✅ Native `useAgent` / `useAgentChat` React hooks
- ✅ Cloudflare edge network
- ✅ Automatic scaling

**Requirements:**
- Cloudflare Workers account
- Durable Objects binding configured
- Deploy to Cloudflare Workers

**Package exports for Workers:**
```typescript
import {
  // Workers infrastructure
  handleCloudflareWorker,
  createCloudflareWorkerHandler,
  handleWebSocketConnection,

  // Agents SDK for Workers
  CloudflareAgentsSDKAdapter,
  createAgentsSDKWorkerHandler,

  // Utilities
  isWebSocketUpgrade,
  getClientIP,
  // ... more utilities
} from '@ag-ui/cloudflare';
```

## Quick Start

### Local Development Setup

```bash
cd integrations/cloudflare/typescript/examples
pnpm install

# Create .env
echo "CLOUDFLARE_ACCOUNT_ID=your_account_id" >> .env
echo "CLOUDFLARE_API_TOKEN=your_api_token" >> .env

pnpm start
```

Server runs on `http://localhost:4114`

### Production Workers Deployment

```typescript
// worker.ts
import {
  createCloudflareWorkerHandler,
  createAgentsSDKWorkerHandler
} from '@ag-ui/cloudflare';

export default {
  async fetch(request: Request, env: Env) {
    // Your agent implementation
    const agent = new MyAgent();

    // Create AG-UI compatible handler
    const handler = createAgentsSDKWorkerHandler({
      agent,
      syncState: true,
      trackSQL: true
    });

    return handler(request, env);
  }
};
```

Configure `wrangler.toml`:
```toml
name = "my-agent"
main = "worker.ts"

[[durable_objects.bindings]]
name = "AGENT"
class_name = "MyAgent"
```

## Available Agents

### Workers AI Agents

Direct model inference - available via HTTP endpoints for npm package users:

| Agent | Description | Model | In Dojo Demo |
|-------|-------------|-------|--------------|
| `agentic_chat` | Basic conversational AI | Llama 3.1 8B | ✅ Yes |
| `tool_based_generative_ui` | UI generation with tools | Llama 3.3 70B FP8 | ✅ Yes |
| `backend_tool_rendering` | Backend-generated UI | Llama 3.3 70B FP8 | ❌ No* |
| `agentic_generative_ui` | Progressive UI updates | Llama 3.1 8B | ❌ No* |
| `shared_state` | Persistent state management | Llama 3.1 8B | ❌ No* |
| `human_in_the_loop` | Human approval workflow | Hermes 2 Pro 7B | ❌ No* |

*Not shown in Dojo demo - requires frontend tools that aren't sent due to CopilotKit limitations

### Agents SDK Agents

Framework-based agents - shown in Dojo demo:

| Agent | Description | In Dojo Demo | Full Features |
|-------|-------------|--------------|---------------|
| `human_in_the_loop_sdk` | Human approval workflow | ✅ Yes | Requires Workers* |
| `tool_based_generative_ui_sdk` | Haiku generation with UI | ✅ Yes | Works locally |

*Full Agents SDK features (WebSocket state sync, Durable Objects) only available when deployed to Cloudflare Workers

## Usage Examples

### Workers AI (Works Everywhere)

```typescript
import { CloudflareAgent, CLOUDFLARE_MODELS } from '@ag-ui/cloudflare';

const agent = new CloudflareAgent({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  model: CLOUDFLARE_MODELS.LLAMA_3_1_8B,
  streamingEnabled: true
});

agent.run({
  threadId: 'thread-1',
  runId: 'run-1',
  messages: [{ role: 'user', content: 'Hello!' }]
}).subscribe(event => {
  console.log(event);
});
```

### Agents SDK (Local/Testing)

```typescript
import { CloudflareAgentsSDKAdapter } from '@ag-ui/cloudflare';

class MyAgent {
  async *onChatMessage(message: string, context: any) {
    yield "Processing...";

    // Emit interrupt for approval
    yield {
      type: "interrupt",
      interrupt: {
        name: "requiresApproval",
        value: { action: "delete_user" }
      }
    };
  }
}

const adapter = new CloudflareAgentsSDKAdapter({
  agent: new MyAgent(),
  syncState: false  // No state sync in local mode
});

for await (const event of adapter.execute(messages, context)) {
  console.log(event);
}
```

### Agents SDK (Production Workers)

```typescript
import { Agent } from 'agents';  // Cloudflare's agents package
import { createAgentsSDKWorkerHandler } from '@ag-ui/cloudflare';

export class MyAgent extends Agent {
  async *onChatMessage(message: string, context: any) {
    // Full state management
    await this.setState({ counter: this.state.counter + 1 });

    // SQL queries
    const users = await this.sql`SELECT * FROM users`;

    // Scheduling
    await this.schedule('1 hour', 'cleanup', {});

    yield `Processed ${this.state.counter} messages`;
  }
}

// AG-UI compatible handler
export default createAgentsSDKWorkerHandler(MyAgent);
```

## Available Models

```typescript
import { CLOUDFLARE_MODELS } from '@ag-ui/cloudflare';

// Function-calling capable (for tool-based agents)
CLOUDFLARE_MODELS.LLAMA_3_3_70B_FP8      // Best for tools
CLOUDFLARE_MODELS.LLAMA_4_SCOUT_17B      // Good for tools
CLOUDFLARE_MODELS.MISTRAL_SMALL_24B      // Good for tools

// General chat (smaller, faster)
CLOUDFLARE_MODELS.LLAMA_3_1_8B           // Best for chat
CLOUDFLARE_MODELS.LLAMA_3_1_70B          // More capable
CLOUDFLARE_MODELS.HERMES_2_PRO_7B        // Good for chat
```

## Architecture

### Local Development Flow
```
Client → Express → CloudflareAgent → Workers AI API → AG-UI Events
Client → Express → AgentsSDKAdapter → Agent.onChatMessage() → AG-UI Events
```

### Production Workers Flow
```
Client → Cloudflare Workers → Durable Objects → AG-UI Events
         ↓
     WebSocket State Sync
         ↓
     React useAgent Hook
```

## Testing

```bash
# Test Workers AI
curl -X POST http://localhost:4114/agentic_chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'

# Test Agents SDK
curl -X POST http://localhost:4114/human_in_the_loop_sdk \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Plan a task"}]}'
```

## Dojo Integration

The Dojo demo app uses the local development setup with two menu entries:

- **Cloudflare Workers AI** - Direct model inference agents
- **Cloudflare Agents SDK** - Framework-based agents

Both point to `http://localhost:4114` running on Express.

## Project Structure

```
integrations/cloudflare/typescript/
├── src/                          # NPM package source
│   ├── cloudflare-agent.ts       # Workers AI client
│   ├── agents-sdk-adapter.ts     # Agents SDK adapter
│   ├── workers-adapter.ts        # Cloudflare Workers utilities
│   ├── cloudflare-utils.ts       # WebSocket & request utilities
│   └── index.ts                  # Public API
└── examples/                     # Local development examples
    └── src/
        ├── agents/               # Example agents
        └── index.ts              # Express server
```

## Learn More

- [Cloudflare Workers AI Docs](https://developers.cloudflare.com/workers-ai/)
- [Cloudflare Agents SDK Docs](https://developers.cloudflare.com/agents/)
- [AG-UI Protocol Spec](https://github.com/CopilotKit/CopilotKit/tree/main/sdks/ag-ui)
- [Durable Objects Guide](https://developers.cloudflare.com/durable-objects/)

## License

MIT
