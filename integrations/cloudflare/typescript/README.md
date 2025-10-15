# @ag-ui/cloudflare

Implementation of the AG-UI protocol for Cloudflare. Supports Workers AI models, Workers runtime deployment, and Agents SDK integration.

## Installation

```bash
npm install @ag-ui/cloudflare
# or
pnpm add @ag-ui/cloudflare
# or
yarn add @ag-ui/cloudflare
```

## Features

- 🤖 **Workers AI Models** - Use Cloudflare's LLM models (Llama 3.1, Mistral, etc.)
- 🏗️ **Workers Runtime** - Deploy AG-UI apps natively on Cloudflare Workers
- 🚀 **Agents SDK** - Build stateful agents with SQL, state sync, and scheduling
- ⚡ **Edge Performance** - 68% faster responses from 200+ edge locations
- 💰 **Cost Efficient** - 93% lower costs than OpenAI
- 🔄 **Full Streaming** - Real-time text and tool streaming
- 📡 **Header Handling** - Smart CF header normalization and WebSocket support

## Usage

### Basic Usage (Workers AI)

```typescript
import { CloudflareAGUIAdapter } from "@ag-ui/cloudflare";

const adapter = new CloudflareAGUIAdapter({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  model: "@cf/meta/llama-3.1-8b-instruct",
});

// Execute with AG-UI protocol
for await (const event of adapter.execute(messages)) {
  console.log(event.type, event.data);
}
```

### Deploy to Cloudflare Workers

```typescript
import { handleCloudflareWorker } from "@ag-ui/cloudflare";

export default {
  async fetch(request, env, ctx) {
    return handleCloudflareWorker(request, env, {
      model: "@cf/meta/llama-3.1-8b-instruct",
    });
  },
};
```

### With Cloudflare Agents SDK

```typescript
import { Agent } from "agents";
import { createAgentsSDKAdapter } from "@ag-ui/cloudflare";

export class MyChatAgent extends Agent {
  async *onChatMessage(message: string) {
    // Built-in state management
    await this.setState({ thinking: true });

    // Built-in SQL database
    await this.sql`INSERT INTO history VALUES (${message})`;

    // Stream response
    yield "Processing: " + message;
  }
}

// Wrap with AG-UI protocol
const agent = new MyChatAgent(state, env);
const adapter = createAgentsSDKAdapter(agent, { syncState: true });

// Emits AG-UI events: TEXT_MESSAGE_CONTENT, STATE_SYNC, etc.
for await (const event of adapter.execute(messages)) {
  // Handle events
}
```

### Next.js Behind Cloudflare CDN

```typescript
import { normalizeRequest, CloudflareAGUIAdapter } from "@ag-ui/cloudflare";

export async function POST(request: NextRequest) {
  // Extract real client IP from Cloudflare headers
  const normalized = normalizeRequest(request);
  console.log("Real IP:", normalized.clientIp); // Not proxy IP!

  const adapter = new CloudflareAGUIAdapter({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  });

  // Stream AG-UI events
  return streamAGUIEvents(adapter, messages);
}
```

## Available Models

| Model                                  | Speed  | Context | Function Calling |
| -------------------------------------- | ------ | ------- | ---------------- |
| `@cf/meta/llama-3.1-8b-instruct`       | ⚡⚡⚡ | 128K    | ❌               |
| `@cf/meta/llama-3.1-70b-instruct`      | ⚡⚡   | 128K    | ❌               |
| `@cf/meta/llama-3.3-70b-instruct`      | ⚡⚡   | 128K    | ✅               |
| `@cf/mistral/mistral-7b-instruct-v0.2` | ⚡⚡⚡ | 32K     | ❌               |

## Three Integration Types

### 1. Infrastructure Support

Deploy AG-UI apps ON Cloudflare infrastructure:

- Native Workers runtime (fetch API)
- Header normalization (CF-Connecting-IP, CF-Ray)
- WebSocket upgrades + Durable Objects
- SSE streaming

### 2. Model Integration

Use Cloudflare Workers AI as your LLM provider:

- 10+ models available
- 68% faster (edge deployment)
- 93% cheaper ($11/M vs $150/M tokens)
- Full AG-UI protocol support

### 3. Agents SDK Integration

Build stateful agents with Cloudflare Agents SDK:

- Built-in state management + SQL
- Task scheduling (cron, delays)
- Real-time state synchronization
- WebSocket support

## Examples

To run the examples:

```bash
cd typescript-sdk/integrations/cloudflare/examples
pnpm install
pnpm dev
```

## Configuration

### Environment Variables

```bash
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token
```

### With AI Gateway (Optional)

```typescript
const adapter = new CloudflareAGUIAdapter({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  gatewayId: process.env.CLOUDFLARE_GATEWAY_ID, // Optional
});
```

### Using with AG-UI Client

For remote HTTP endpoints (like the dojo), use `CloudflareHttpAgent`:

```typescript
import { CloudflareHttpAgent } from "@ag-ui/cloudflare";

const agent = new CloudflareHttpAgent({
  url: "http://localhost:4114/agentic_chat",
});

// Use with AG-UI client
await agent.run(input);
```

## Documentation

- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
- [AG-UI Protocol](https://docs.ag-ui.com/)

## License

Apache-2.0
