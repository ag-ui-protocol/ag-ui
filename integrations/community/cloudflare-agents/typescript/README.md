# @ag-ui/cloudflare-agents

AG-UI community integration for Cloudflare Agents. Provides a WebSocket client for connecting to deployed Cloudflare Workers and a server-side adapter for converting Vercel AI SDK v5 streams into AG-UI protocol events.

## Components

- **CloudflareAgentsClient** -- WebSocket client that connects to deployed Cloudflare Workers and translates their events to AG-UI protocol events.
- **AgentsToAGUIAdapter** -- Server-side adapter that converts Vercel AI SDK v5 `StreamTextResult` into AG-UI events.
- **createSSEResponse / createNDJSONResponse** -- Helper functions to stream AG-UI events over HTTP as Server-Sent Events or newline-delimited JSON.

## Installation

```bash
npm install @ag-ui/cloudflare-agents
# or
pnpm add @ag-ui/cloudflare-agents
```

### Peer Dependencies

- `@ag-ui/client` (>=0.0.40)
- `@ag-ui/core` (>=0.0.37)
- `ai` (^5.0.0) -- Vercel AI SDK v5+
- `@cloudflare/workers-types` (>=4.0.0)

## Usage

### Client: Connect to a Deployed Agent

```typescript
import { CloudflareAgentsClient } from "@ag-ui/cloudflare-agents";

const agent = new CloudflareAgentsClient({
  url: "wss://your-agent.workers.dev",
});

agent
  .runAgent({
    threadId: "thread-123",
    runId: "run-456",
    messages: [{ role: "user", content: "What's the weather?" }],
  })
  .subscribe({
    next: (event) => {
      switch (event.type) {
        case "TEXT_MESSAGE_CONTENT":
          process.stdout.write(event.delta);
          break;
        case "STATE_SNAPSHOT":
          console.log("State:", event.snapshot);
          break;
        case "TOOL_CALL_START":
          console.log("Calling tool:", event.toolCallName);
          break;
      }
    },
    complete: () => console.log("Done"),
  });
```

### Adapter: Build an Agent with SSE Streaming

```typescript
import { AgentsToAGUIAdapter, createSSEResponse } from "@ag-ui/cloudflare-agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { from } from "rxjs";

const adapter = new AgentsToAGUIAdapter();

export default {
  async fetch(request: Request): Promise<Response> {
    const { messages, threadId, runId } = await request.json();

    const stream = streamText({
      model: openai("gpt-4"),
      messages,
    });

    const events$ = from(
      adapter.adaptStreamToAGUI(stream, threadId, runId, messages)
    );

    return createSSEResponse(events$);
  },
};
```

### Adapter: WebSocket Agent with Tools

```typescript
import { Agent } from "agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { AgentsToAGUIAdapter } from "@ag-ui/cloudflare-agents";
import { z } from "zod";

export class MyAgent extends Agent {
  private adapter = new AgentsToAGUIAdapter();

  async onMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const data = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const { messages, threadId } = JSON.parse(data);

    const stream = streamText({
      model: openai("gpt-4"),
      messages,
      tools: {
        getWeather: {
          description: "Get current weather",
          parameters: z.object({ location: z.string() }),
          execute: async ({ location }) => ({ temperature: 72, condition: "sunny" }),
        },
      },
    });

    for await (const event of this.adapter.adaptStreamToAGUI(
      stream, threadId, crypto.randomUUID(), messages
    )) {
      ws.send(JSON.stringify(event));
    }
  }
}
```

## Supported AG-UI Events

| Event | Supported |
|---|---|
| RUN_STARTED / RUN_FINISHED / RUN_ERROR | Yes |
| TEXT_MESSAGE_START / CONTENT / END | Yes |
| TOOL_CALL_START / ARGS / END | Yes (includes streaming args via tool-input-*) |
| TOOL_CALL_RESULT | Yes (including error results) |
| REASONING_START / MESSAGE_START / MESSAGE_CONTENT / MESSAGE_END / END | Yes |
| STATE_SNAPSHOT | Yes |
| MESSAGES_SNAPSHOT | Yes (with tool calls and results) |
| STEP_STARTED / STEP_FINISHED | Yes |
| RAW | Yes (adapter: AI SDK raw parts; client: unknown CF event types) |
| CUSTOM | Yes (adapter: source/file parts; client: CUSTOM CF events) |
| STATE_DELTA | Not yet |
| ACTIVITY_SNAPSHOT / ACTIVITY_DELTA | Not yet |
| REASONING_ENCRYPTED_VALUE | Not yet |
| Interrupt / Resume | Not yet |
| Subgraph support | Not yet |

## Not Yet Supported

- **STATE_DELTA** -- Requires application-level state diffing (JSON Patch RFC 6902) against previous state; currently only full STATE_SNAPSHOT is emitted.
- **ACTIVITY_SNAPSHOT / ACTIVITY_DELTA** -- Requires application-level activity tracking.
- **REASONING_ENCRYPTED_VALUE** -- Depends on the provider exposing encrypted reasoning signatures.
- **Interrupt/resume** -- Requires Cloudflare Agents SDK checkpointing support for pausing and resuming agent runs.
- **Subgraph support** -- This is a LangGraph-specific concept and does not apply to the Cloudflare Agents architecture.

## Requirements

- Vercel AI SDK v5+ (uses the `fullStream` API)
- Cloudflare Workers runtime (for deployment)
- Node.js 18+ or modern browser (for the client)

## License

MIT
