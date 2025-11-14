# @ag-ui/cloudflare-agents

AG-UI integration for Cloudflare Agents - Build AI agents that run on Cloudflare Workers with Durable Objects and stream responses via the AG-UI protocol.

## Features

- **Cloudflare Agents Integration** – Extends Cloudflare's AIChatAgent with AG-UI protocol support
- **Edge Computing** – Run AI agents on Cloudflare's global network
- **Durable Objects** – Persistent state management with automatic hibernation
- **Real-time Streaming** – SSE and NDJSON streaming support
- **Tool Calling** – Automatic conversion of AI SDK tool calls to AG-UI events
- **Vercel AI SDK** – Use any LLM provider supported by Vercel AI SDK
- **Zero Cold Starts** – Agents wake instantly when needed

## Installation

```bash
npm install @ag-ui/cloudflare-agents agents ai @ai-sdk/openai
# or
pnpm add @ag-ui/cloudflare-agents agents ai @ai-sdk/openai
```

## Quick Start

### Basic Agent

```typescript
import { CloudflareAgentsAgent, type Message } from "@ag-ui/cloudflare-agents";
import type { AgentContext } from "agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

interface Env {
  OPENAI_API_KEY: string;
}

// Extend CloudflareAgentsAgent
export class ChatAgent extends CloudflareAgentsAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
  }

  protected async generateResponse(messages: Message[]) {
    return streamText({
      model: openai("gpt-4o-mini", { apiKey: this.env.OPENAI_API_KEY }),
      messages,
    });
  }
}
```

### Cloudflare Worker Integration

```typescript
import { createSSEResponse, type Message } from "@ag-ui/cloudflare-agents";
import type { AgentContext } from "agents";
import { ChatAgent } from "./chat-agent";

export interface Env {
  OPENAI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.json() as {
      messages: Message[];
      threadId?: string;
    };

    // Create agent context
    const ctx = {
      id: { toString: () => body.threadId || "default" }
    } as AgentContext;

    // Create and run agent
    const agent = new ChatAgent(ctx, env);
    const events$ = agent.run({
      messages: body.messages,
      threadId: body.threadId,
    });

    // Return SSE stream
    return createSSEResponse(events$);
  },
};
```

### With Tools

```typescript
import { CloudflareAgentsAgent, type Message } from "@ag-ui/cloudflare-agents";
import type { AgentContext } from "agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export class WeatherAgent extends CloudflareAgentsAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
  }

  protected async generateResponse(messages: Message[]) {
    return streamText({
      model: openai("gpt-4o-mini", { apiKey: this.env.OPENAI_API_KEY }),
      messages,
      tools: {
        getWeather: {
          description: "Get current weather for a location",
          parameters: z.object({
            location: z.string().describe("City name"),
          }),
          execute: async ({ location }) => {
            // Call your weather API
            return {
              location,
              temperature: 72,
              condition: "sunny",
            };
          },
        },
      },
    });
  }
}
```

### With Durable Objects

```typescript
import { DurableObject } from "cloudflare:workers";
import { CloudflareAgentsAgent, createSSEResponse, type Message } from "@ag-ui/cloudflare-agents";
import type { AgentContext } from "agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export class PersistentChatAgent extends DurableObject {
  async fetch(request: Request) {
    const body = await request.json() as { messages: Message[] };

    // Agent with Durable Object context
    class StatefulAgent extends CloudflareAgentsAgent<Env> {
      constructor(ctx: AgentContext, env: Env, private storage: DurableObjectStorage) {
        super(ctx, env);
      }

      protected async generateResponse(messages: Message[]) {
        // Access persistent storage
        const history = await this.storage.get<Message[]>("history") || [];

        return streamText({
          model: openai("gpt-4o-mini", { apiKey: this.env.OPENAI_API_KEY }),
          messages: [...history, ...messages],
        });
      }
    }

    const ctx = { id: this.ctx.id } as AgentContext;
    const agent = new StatefulAgent(ctx, this.env, this.ctx.storage);
    const events$ = agent.run({ messages: body.messages });

    return createSSEResponse(events$);
  }
}
```

## How It Works

This integration connects three pieces:

```
Cloudflare Agents (AIChatAgent)
    ↓ You extend it
CloudflareAgentsAgent
    ↓ You return Vercel AI SDK stream
Adapter (Vercel AI → AG-UI)
    ↓ Produces
AG-UI Protocol Events
```

### Why Vercel AI SDK?

Cloudflare Agents uses Vercel AI SDK internally, and we leverage it for:

- **Model flexibility** - Works with OpenAI, Anthropic, Google, etc.
- **Tool calling** - Built-in function calling support
- **Streaming** - Native async streaming
- **Community standard** - Most developers already use it

The adapter automatically converts Vercel AI SDK streams into AG-UI protocol events, so you don't have to manually emit `RUN_STARTED`, `TEXT_MESSAGE_CHUNK`, etc.

### What the Adapter Does

Takes **Vercel AI SDK output**:
```typescript
{
  textStream: AsyncIterable<string>,
  toolCalls: ToolCall[],
  text: string
}
```

Converts to **AG-UI events**:
```typescript
RUN_STARTED → TEXT_MESSAGE_CHUNK → TOOL_CALL_* → RUN_FINISHED
```

## API Reference

### `CloudflareAgentsAgent<Env, State>`

Extends Cloudflare's `AIChatAgent` and adds AG-UI protocol support.

**Constructor:**
```typescript
constructor(
  ctx: AgentContext,
  env: Env,
  config?: CloudflareAgentsAgentConfig
)
```

**Parameters:**
- `ctx: AgentContext` - Cloudflare Agents context (from Durable Object or stub)
- `env: Env` - Environment variables (API keys, etc.)
- `config?: CloudflareAgentsAgentConfig` - Optional configuration

**Methods:**
- `run(input: RunAgentInput): Observable<BaseEvent>` - Run agent and get AG-UI events
- `generateResponse(messages: Message[]): Promise<StreamTextResult>` - Override this to define AI behavior

### `createSSEResponse()`

Create Server-Sent Events response for AG-UI streaming.

```typescript
createSSEResponse(
  events$: Observable<BaseEvent>,
  customHeaders?: Record<string, string>
): Response
```

### `createNDJSONResponse()`

Create newline-delimited JSON response.

```typescript
createNDJSONResponse(
  events$: Observable<BaseEvent>,
  customHeaders?: Record<string, string>
): Response
```

## AG-UI Events

The integration automatically emits these AG-UI protocol events:

- `RUN_STARTED` - Agent execution begins
- `TEXT_MESSAGE_CHUNK` - Streaming text responses
- `TOOL_CALL_START` - Tool invocation begins
- `TOOL_CALL_ARGS` - Tool arguments received
- `TOOL_CALL_END` - Tool invocation completes
- `TOOL_CALL_RESULT` - Tool execution result
- `MESSAGES_SNAPSHOT` - Complete message history
- `RUN_FINISHED` - Agent execution completes
- `RUN_ERROR` - Error occurred

## Examples

### Multi-turn Conversation

```typescript
const agent = new ChatAgent(ctx, env);

// First turn
const events1$ = agent.run({
  threadId: "thread-1",
  messages: [{ role: "user", content: "Hello!" }],
});

// Second turn (same thread)
const events2$ = agent.run({
  threadId: "thread-1",
  messages: [
    { role: "user", content: "Hello!" },
    { role: "assistant", content: "Hi there!" },
    { role: "user", content: "How are you?" },
  ],
});
```

### Using Different Models

```typescript
import { anthropic } from "@ai-sdk/anthropic";

export class ClaudeAgent extends CloudflareAgentsAgent<Env> {
  protected async generateResponse(messages: Message[]) {
    return streamText({
      model: anthropic("claude-3-5-sonnet-20241022", { apiKey: this.env.ANTHROPIC_API_KEY }),
      messages,
    });
  }
}
```

## Secrets Management

### Local Development

⚠️ **NEVER commit secrets to git!** Use `.dev.vars` for local development:

1. Copy the example file:
```bash
cp .dev.vars.example .dev.vars
```

2. Add your API keys to `.dev.vars`:
```bash
OPENAI_API_KEY=sk-proj-your-actual-key-here
```

3. The `.dev.vars` file is automatically gitignored.

### Production Deployment

**DO NOT use `.dev.vars` files in production!** Use Wrangler secrets:

```bash
# Set production secrets
wrangler secret put OPENAI_API_KEY --env production

# Set staging secrets
wrangler secret put OPENAI_API_KEY --env staging
```

Secrets set via `wrangler secret put` are:
- Encrypted at rest
- Not visible in code or logs
- Environment-specific
- Accessible via `env.OPENAI_API_KEY`

### Environment Variables vs Secrets

**Use environment variables (in `wrangler.jsonc`)** for:
- Non-sensitive configuration
- Public URLs
- Feature flags

**Use secrets (`.dev.vars` or `wrangler secret put`)** for:
- API keys
- Passwords
- Tokens

Example `wrangler.jsonc`:
```jsonc
{
  "vars": {
    "ENVIRONMENT": "development",  // ✅ OK - not sensitive
    "LOG_LEVEL": "debug"           // ✅ OK - not sensitive
  },
  "env": {
    "production": {
      "vars": {
        "ENVIRONMENT": "production"
      }
      // ❌ DO NOT put secrets here!
      // Use: wrangler secret put OPENAI_API_KEY --env production
    }
  }
}
```

## Deployment

Deploy to Cloudflare Workers:

```bash
# Install Wrangler
npm install -g wrangler

# Set production secrets (first time only)
wrangler secret put OPENAI_API_KEY --env production

# Deploy
wrangler deploy --env production
```

Your agent will be available at:
```
https://your-worker.workers.dev
```

## Testing

Use the [AG-UI Dojo](https://agui-demo.vercel.app) to test your agent:

1. Deploy your worker
2. Open AG-UI Dojo
3. Enter your worker URL
4. Start chatting!

## Learn More

- [AG-UI Documentation](https://docs.ag-ui.com)
- [Cloudflare Agents](https://github.com/cloudflare/agents)
- [Cloudflare Workers](https://workers.cloudflare.com)
- [Durable Objects](https://developers.cloudflare.com/durable-objects)
- [Vercel AI SDK](https://sdk.vercel.ai/docs)

## Contributing

Contributions are welcome! This is a community integration.

## License

MIT
