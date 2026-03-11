---
name: agui-http-agent-setup
description: >
  Use the HttpAgent class to connect to a remote AG-UI agent endpoint via SSE.
  Configure url, headers, authentication, AbortController cancellation, and
  subscriber callbacks for event handling.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/client/src/agent/http.ts
  - ag-ui-protocol/ag-ui:docs/sdk/js/client/http-agent.mdx
requires:
  - agui-implement-abstract-agent
---

# AG-UI — HTTP Agent Setup

## Setup

Connect to a remote AG-UI agent endpoint:

```typescript
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://your-agent-endpoint.com/agent",
});

// Run the agent and get the result
const { result, newMessages } = await agent.runAgent();
```

Install dependencies:

```bash
pnpm add @ag-ui/client @ag-ui/core rxjs
```

## Core Patterns

### Pattern 1: Authentication and custom headers

`HttpAgent` accepts a `headers` record in its config. These are merged with the
default `Content-Type: application/json` and `Accept: text/event-stream` headers
on every request. The `Accept` header is set automatically -- do not override it.

```typescript
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://your-agent-endpoint.com/agent",
  headers: {
    "Authorization": "Bearer your-api-key",
    "X-Custom-Header": "value",
  },
  // Optional: pre-seed conversation state
  threadId: "thread-123",
  initialMessages: [
    { id: "msg-1", role: "user", content: "Hello" },
  ],
  initialState: { language: "en" },
});

const { result, newMessages } = await agent.runAgent({
  tools: [
    {
      name: "getWeather",
      description: "Get current weather",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      },
    },
  ],
});
```

### Pattern 2: Cancelling a run with AbortController

Each `runAgent()` call creates (or accepts) an `AbortController`. Call
`agent.abortRun()` to cancel the in-flight HTTP request.

```typescript
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://your-agent-endpoint.com/agent",
});

// Start a run
const runPromise = agent.runAgent();

// Cancel it after 5 seconds
setTimeout(() => {
  agent.abortRun();
}, 5000);

try {
  await runPromise;
} catch (error) {
  // AbortError is thrown when the request is cancelled
  console.log("Run was cancelled");
}
```

You can also provide your own `AbortController`:

```typescript
const controller = new AbortController();

const runPromise = agent.runAgent({
  abortController: controller,
});

// Cancel from external signal
controller.abort();
```

### Pattern 3: Subscribing to events

Use `agent.subscribe()` to react to events as they stream in. Subscribers work
with both `HttpAgent` and any `AbstractAgent` subclass.

```typescript
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://your-agent-endpoint.com/agent",
});

// Global subscriber (persists across runs)
const subscription = agent.subscribe({
  onTextMessageContentEvent: ({ event }) => {
    process.stdout.write(event.delta);
  },
  onRunFinishedEvent: ({ result }) => {
    console.log("\nRun finished with result:", result);
  },
  onRunFailed: ({ error }) => {
    console.error("Run failed:", error);
  },
  onMessagesChanged: ({ messages }) => {
    console.log("Messages updated, count:", messages.length);
  },
  onStateChanged: ({ state }) => {
    console.log("State updated:", state);
  },
});

await agent.runAgent();

// Unsubscribe when done
subscription.unsubscribe();
```

You can also pass a one-time subscriber directly to `runAgent()`:

```typescript
await agent.runAgent({}, {
  onTextMessageContentEvent: ({ event }) => {
    process.stdout.write(event.delta);
  },
});
```

### Pattern 4: Customizing the HTTP request

Override `requestInit()` to customize the fetch call (e.g., adding cookies,
changing the method, or adding query parameters):

```typescript
import { HttpAgent } from "@ag-ui/client";
import { RunAgentInput } from "@ag-ui/core";

class CustomHttpAgent extends HttpAgent {
  protected requestInit(input: RunAgentInput): RequestInit {
    const base = super.requestInit(input);
    return {
      ...base,
      credentials: "include",
      headers: {
        ...base.headers as Record<string, string>,
        "X-Request-Id": input.runId,
      },
    };
  }
}
```

## Common Mistakes

### 1. Missing Accept header for SSE (MEDIUM)

`HttpAgent` sets `Accept: text/event-stream` by default. If you override `requestInit()` and rebuild headers from scratch without including `Accept`, the server may respond with the wrong content type.

Wrong:

```typescript
protected requestInit(input: RunAgentInput): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Missing Accept header - server won't know to use SSE
    },
    body: JSON.stringify(input),
  };
}
```

Correct:

```typescript
protected requestInit(input: RunAgentInput): RequestInit {
  // Extend super.requestInit() to preserve default headers
  const base = super.requestInit(input);
  return {
    ...base,
    // your customizations here
  };
}
```

### 2. Calling abortRun() outside of an active run (MEDIUM)

Each `runAgent()` call creates a new `AbortController`. Calling `abortRun()` when no run is active aborts a stale controller and has no effect on the next run.

Wrong:

```typescript
agent.abortRun(); // No run is active -- this does nothing useful
await agent.runAgent(); // New AbortController created, previous abort has no effect
```

Correct:

```typescript
const runPromise = agent.runAgent();
// Abort while the run is active
agent.abortRun();
await runPromise;
```

### 3. Not providing threadId and runId (MEDIUM)

`HttpAgent` sends `RunAgentInput` as the JSON body. The server expects `threadId` and `runId` to track conversation state. `AbstractAgent` auto-generates these if not provided, so this is safe by default. However, if you need deterministic IDs for persistence or debugging, provide them explicitly.

Wrong:

```typescript
// IDs are auto-generated -- hard to correlate with server-side logs
await agent.runAgent();
```

Correct (when deterministic IDs are needed):

```typescript
const agent = new HttpAgent({
  url: "https://your-agent-endpoint.com/agent",
  threadId: "thread-abc-123", // Deterministic thread ID
});

await agent.runAgent({
  runId: "run-xyz-456", // Deterministic run ID
});
```

See also: `agui-implement-abstract-agent`, `agui-event-encoding`
