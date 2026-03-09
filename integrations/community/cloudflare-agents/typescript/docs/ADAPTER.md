# AgentsToAGUIAdapter

Adapter for converting Vercel AI SDK streaming responses to AG-UI protocol events.

## Overview

`AgentsToAGUIAdapter` bridges the Vercel AI SDK and AG-UI protocol, enabling Cloudflare Agents to emit AG-UI events. It handles:

- Text message streaming with automatic chunking
- Tool call execution and results
- State management (snapshots and deltas)
- Message history snapshots
- Activity tracking
- Custom and raw events

## Basic Usage

```typescript
import { AgentsToAGUIAdapter } from "@ag-ui/cloudflare-agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const adapter = new AgentsToAGUIAdapter();

const stream = streamText({
  model: openai("gpt-4"),
  messages: inputMessages,
});

for await (const event of adapter.adaptStreamToAGUI(
  stream,
  "thread-123",
  "run-456",
  inputMessages
)) {
  // Send AG-UI event to client
  ws.send(JSON.stringify(event));
}
```

## Event Patterns

The adapter implements all AG-UI event patterns:

### 1. Lifecycle Pattern

```
RUN_STARTED
  ↓
[events...]
  ↓
RUN_FINISHED / RUN_ERROR
```

### 2. Start-Content-End Pattern (Text Streaming)

AG-UI automatically expands `TEXT_MESSAGE_CHUNK` events:

```typescript
// First chunk (includes messageId and role)
{
  type: "TEXT_MESSAGE_CHUNK",
  messageId: "msg-123",
  role: "assistant",
  delta: "Hello",
  timestamp: 1234567890
}

// Subsequent chunks (only delta)
{
  type: "TEXT_MESSAGE_CHUNK",
  delta: " world",
  timestamp: 1234567891
}
```

AG-UI expands to:
```
TEXT_MESSAGE_START (messageId, role)
  ↓
TEXT_MESSAGE_CONTENT (delta) × N
  ↓
TEXT_MESSAGE_END
```

### 3. Tool Call Pattern

```typescript
// Tool call chunk (automatically expands)
{
  type: "TOOL_CALL_CHUNK",
  toolCallId: "call-123",
  toolCallName: "search",
  parentMessageId: "msg-123",
  delta: '{"query":"weather"}',
  timestamp: 1234567890
}
```

AG-UI expands to:
```
TOOL_CALL_START (toolCallId, toolCallName)
  ↓
TOOL_CALL_ARGS (delta) × N
  ↓
TOOL_CALL_END
```

### 4. State Management Pattern

**STATE_SNAPSHOT** - Complete state replacement:
```typescript
{
  type: "STATE_SNAPSHOT",
  snapshot: { count: 1, user: "alice" },
  timestamp: 1234567890
}
```

**STATE_DELTA** - Incremental updates (JSON Patch):
```typescript
{
  type: "STATE_DELTA",
  patch: [
    { op: "replace", path: "/count", value: 2 }
  ],
  timestamp: 1234567890
}
```

Use STATE_SNAPSHOT for:
- Initial state
- Complete resets
- Infrequent, large updates

Use STATE_DELTA for:
- Frequent updates
- Minimal data transfer
- Incremental changes

### 5. Messages Snapshot Pattern

Provides complete conversation history:

```typescript
{
  type: "MESSAGES_SNAPSHOT",
  messages: [
    { id: "msg-1", role: "user", content: "Hello" },
    { id: "msg-2", role: "assistant", content: "Hi there!" }
  ],
  timestamp: 1234567890
}
```

Useful for:
- Initializing chat history
- Post-interruption sync
- Conversation context refresh

### 6. Activity Events Pattern

Activity events expose structured, in-progress updates between messages:

**ACTIVITY_SNAPSHOT** - Complete activity state:
```typescript
{
  type: "ACTIVITY_SNAPSHOT",
  messageId: "msg-123",
  activityType: "PLAN",
  content: {
    title: "Execution Plan",
    steps: ["Step 1", "Step 2", "Step 3"],
    currentStep: 0
  },
  replace: true, // Replace existing plan activity
  timestamp: 1234567890
}
```

**ACTIVITY_DELTA** - Incremental updates:
```typescript
{
  type: "ACTIVITY_DELTA",
  messageId: "msg-123",
  activityType: "PLAN",
  patch: [
    { op: "replace", path: "/currentStep", value: 1 }
  ],
  timestamp: 1234567890
}
```

Common activity types:
- `PLAN` - Execution plans
- `SEARCH` - Search operations
- `REASONING` - Reasoning steps
- `ANALYSIS` - Data analysis
- Custom types for your application

### 7. Custom Events Pattern

Extension mechanism for application-specific events:

```typescript
// Progress event
{
  type: "CUSTOM",
  name: "progress",
  value: { current: 5, total: 10, percentage: 50 },
  timestamp: 1234567890
}

// Notification event
{
  type: "CUSTOM",
  name: "notification",
  value: { level: "info", message: "Processing complete" },
  timestamp: 1234567890
}
```

CUSTOM events are part of the protocol (unlike RAW events).

### 8. Raw Events Pattern

Container for external system events:

```typescript
// External system event
{
  type: "RAW",
  event: {
    type: "EXTERNAL_UPDATE",
    payload: { status: "processing", id: "ext-123" }
  },
  source: "external-api",
  timestamp: 1234567890
}

// Legacy system event
{
  type: "RAW",
  event: {
    eventType: "LEGACY_NOTIFICATION",
    data: { message: "Process complete" }
  },
  source: "legacy-system",
  timestamp: 1234567890
}
```

Use for wrapping third-party events, legacy systems, or external APIs.

## Complete Example

```typescript
import { AgentsToAGUIAdapter } from "@ag-ui/cloudflare-agents";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export async function handleAgentRequest(
  ws: WebSocket,
  inputMessages: Message[]
) {
  const adapter = new AgentsToAGUIAdapter();

  // Create AI SDK stream
  const stream = streamText({
    model: openai("gpt-4"),
    messages: inputMessages,
    tools: {
      search: {
        description: "Search for information",
        parameters: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => {
          return await performSearch(query);
        },
      },
    },
  });

  // Convert to AG-UI events and send to client
  try {
    for await (const event of adapter.adaptStreamToAGUI(
      stream,
      "thread-123",
      "run-456",
      inputMessages,
      undefined, // parentRunId
      { count: 0 } // initial state
    )) {
      ws.send(JSON.stringify(event));
    }
  } catch (error) {
    ws.send(JSON.stringify({
      type: "RUN_ERROR",
      message: error.message,
      code: "ADAPTER_ERROR",
      timestamp: Date.now()
    }));
  }
}
```

## Event Sequence

A typical event sequence from the adapter:

```
1. RUN_STARTED (with input)
2. STATE_SNAPSHOT (if initial state provided)
3. STEP_STARTED ("Generating Response")
4. TEXT_MESSAGE_CHUNK × N (streaming text)
5. STEP_FINISHED ("Generating Response")
6. STEP_STARTED ("Executing Tools") [if tools used]
7. TOOL_CALL_CHUNK × N (for each tool)
8. STEP_FINISHED ("Executing Tools")
9. TOOL_CALL_RESULT × N (tool results)
10. MESSAGES_SNAPSHOT (complete conversation)
11. RUN_FINISHED (with result)
```

## Advanced Patterns

### With Parent Run ID (Branching)

```typescript
for await (const event of adapter.adaptStreamToAGUI(
  stream,
  threadId,
  runId,
  inputMessages,
  parentRunId // Enable branching/time travel
)) {
  ws.send(JSON.stringify(event));
}
```

### With Initial State

```typescript
for await (const event of adapter.adaptStreamToAGUI(
  stream,
  threadId,
  runId,
  inputMessages,
  undefined,
  { user: "alice", preferences: {...} }
)) {
  ws.send(JSON.stringify(event));
}
```

### Emitting Custom Events

The adapter handles standard AI SDK events. To emit custom events, manually yield them:

```typescript
async function* customAdapter(stream, ...args) {
  const adapter = new AgentsToAGUIAdapter();

  for await (const event of adapter.adaptStreamToAGUI(stream, ...args)) {
    yield event;

    // Emit custom progress event
    if (event.type === "STEP_STARTED") {
      yield {
        type: "CUSTOM",
        name: "progress",
        value: { step: event.stepName },
        timestamp: Date.now()
      };
    }
  }
}
```

### Emitting Activity Events

```typescript
async function* activityAdapter(stream, ...args) {
  const adapter = new AgentsToAGUIAdapter();

  for await (const event of adapter.adaptStreamToAGUI(stream, ...args)) {
    yield event;

    // Emit plan activity
    if (event.type === "STEP_STARTED" && event.stepName === "Planning") {
      yield {
        type: "ACTIVITY_SNAPSHOT",
        messageId: "msg-123",
        activityType: "PLAN",
        content: {
          title: "Execution Plan",
          steps: ["Analyze", "Execute", "Verify"]
        },
        replace: true,
        timestamp: Date.now()
      };
    }
  }
}
```

## Error Handling

The adapter catches errors and emits RUN_ERROR:

```typescript
try {
  for await (const event of adapter.adaptStreamToAGUI(...)) {
    ws.send(JSON.stringify(event));
  }
} catch (error) {
  // Adapter already emits RUN_ERROR
  // Additional handling if needed
}
```

RUN_ERROR event structure:
```typescript
{
  type: "RUN_ERROR",
  message: "Error description",
  code: "STREAM_ERROR",
  timestamp: 1234567890
}
```

## Integration with Cloudflare Workers

```typescript
import { routeAgentRequest } from "agents";
import { AgentsToAGUIAdapter } from "@ag-ui/cloudflare-agents";

export default {
  async fetch(req: Request, env: Env) {
    // Let Agents SDK handle WebSocket upgrade
    const agentResponse = routeAgentRequest(req, env);
    if (agentResponse) return agentResponse;

    // Handle other routes
    return new Response("Not found", { status: 404 });
  }
};

// In your agent class
class MyAgent extends Agent {
  async onMessage(ws: WebSocket, message: string) {
    const { messages } = JSON.parse(message);
    const adapter = new AgentsToAGUIAdapter();

    const stream = streamText({
      model: openai("gpt-4"),
      messages
    });

    for await (const event of adapter.adaptStreamToAGUI(
      stream,
      crypto.randomUUID(),
      crypto.randomUUID(),
      messages
    )) {
      ws.send(JSON.stringify(event));
    }
  }
}
```

## API Reference

### `adaptStreamToAGUI()`

```typescript
async *adaptStreamToAGUI(
  stream: StreamTextResult<any, any>,
  threadId?: string,
  runId?: string,
  inputMessages?: Message[],
  parentRunId?: string,
  state?: any
): AsyncGenerator<BaseEvent>
```

**Parameters:**
- `stream` - Vercel AI SDK StreamTextResult
- `threadId` - Thread ID (default: random UUID)
- `runId` - Run ID (default: random UUID)
- `inputMessages` - Input messages for snapshot (default: [])
- `parentRunId` - Parent run ID for branching (optional)
- `state` - Initial agent state (optional)

**Returns:** AsyncGenerator yielding AG-UI BaseEvent objects

**Yields:**
- `RUN_STARTED` - Always first
- `STATE_SNAPSHOT` - If state provided
- `STEP_STARTED` - For each step
- `TEXT_MESSAGE_CHUNK` - For streaming text
- `STEP_FINISHED` - After each step
- `TOOL_CALL_CHUNK` - For tool calls
- `TOOL_CALL_RESULT` - For tool results
- `MESSAGES_SNAPSHOT` - Before RUN_FINISHED
- `RUN_FINISHED` - Always last (success)
- `RUN_ERROR` - On error (instead of RUN_FINISHED)
