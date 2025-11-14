# CloudflareAgentsClient

WebSocket-based client for connecting to deployed Cloudflare Agents from AG-UI applications.

## Overview

`CloudflareAgentsClient` extends `AbstractAgent` and provides a WebSocket connection to Cloudflare Workers running the Cloudflare Agents SDK. It handles:

- WebSocket connection management (connect, reconnect, disconnect)
- Event transformation (Cloudflare → AG-UI protocol)
- Message ID tracking across streaming chunks
- State synchronization from server `this.setState()` calls
- Error handling and resilient message parsing

## Basic Usage

```typescript
import { CloudflareAgentsClient } from "@ag-ui/cloudflare-agents";

const agent = new CloudflareAgentsClient({
  url: "wss://your-worker.workers.dev"
});

const subscription = agent.runAgent({
  messages: [{ role: "user", content: "Hello!" }],
  threadId: "thread-123",
  runId: "run-456"
}).subscribe({
  next: (event) => {
    console.log(event.type, event);
  },
  error: (err) => {
    console.error("Error:", err);
  },
  complete: () => {
    console.log("Stream completed");
  }
});

// Later, to abort:
agent.abortRun();
// or
subscription.unsubscribe();
```

## Event Flow

```
Client → WebSocket → Cloudflare Worker
  ↓
RUN_STARTED
  ↓
TEXT_MESSAGE_CHUNK (streaming)
  ↓
STATE_SNAPSHOT (if server calls setState)
  ↓
RUN_FINISHED
```

## Event Transformation

The client automatically transforms Cloudflare SDK events to AG-UI events:

| Cloudflare Event | AG-UI Event | Description |
|-----------------|-------------|-------------|
| `TEXT_CHUNK` | `TEXT_MESSAGE_CHUNK` | Streaming text from LLM |
| `cf_agent_state` | `STATE_SNAPSHOT` | State updates from `this.setState()` |
| `READY`, `PONG` | *(ignored)* | Connection lifecycle events |

### TEXT_CHUNK → TEXT_MESSAGE_CHUNK

When the server sends text chunks:

```json
{ "type": "TEXT_CHUNK", "text": "Hello", "messageId": "msg-1" }
```

The client transforms it to:

```json
{
  "type": "TEXT_MESSAGE_CHUNK",
  "messageId": "msg-1",
  "role": "assistant",
  "delta": "Hello",
  "timestamp": 1234567890
}
```

AG-UI automatically expands this to:
1. `TEXT_MESSAGE_START` (first chunk only)
2. `TEXT_MESSAGE_CONTENT` (each chunk)
3. `TEXT_MESSAGE_END` (when messageId changes or stream ends)

### cf_agent_state → STATE_SNAPSHOT

When the server calls `this.setState()`, Cloudflare Agents SDK automatically broadcasts:

```json
{
  "type": "cf_agent_state",
  "state": { "count": 1, "user": "alice" }
}
```

The client transforms it to:

```json
{
  "type": "STATE_SNAPSHOT",
  "state": { "count": 1, "user": "alice" },
  "timestamp": 1234567890
}
```

## Message ID Tracking

The client intelligently tracks message IDs across chunks:

1. **Server provides ID**: Uses it (allows server to control message boundaries)
2. **No current ID**: Generates new UUID (first chunk of new message)
3. **Has current ID**: Reuses it (continuation of current message)

This ensures all chunks belonging to the same message share the same `messageId`, which AG-UI requires for proper grouping.

## WebSocket Connection

### Browser Environment

Uses native `WebSocket` API:

```typescript
const agent = new CloudflareAgentsClient({
  url: "wss://your-worker.workers.dev"
});
```

### Node.js Environment

Requires the `ws` package:

```bash
npm install ws
```

```typescript
import WebSocket from "ws";
globalThis.WebSocket = WebSocket;

const agent = new CloudflareAgentsClient({
  url: "wss://your-worker.workers.dev"
});
```

## Error Handling

### Parse Errors

If a message fails to parse, the client:
1. Logs the error for debugging
2. Emits `RUN_ERROR` event with code `"PARSE_ERROR"`
3. Continues processing subsequent messages (doesn't crash the stream)

```typescript
agent.runAgent({ messages }).subscribe({
  next: (event) => {
    if (event.type === "RUN_ERROR" && event.code === "PARSE_ERROR") {
      console.warn("Malformed message from server");
    }
  }
});
```

### WebSocket Errors

Fatal connection errors (network issues, server unavailable):

```typescript
agent.runAgent({ messages }).subscribe({
  error: (err) => {
    // WebSocket connection failed
    console.error("Connection error:", err);
  }
});
```

## Advanced Usage

### State Tracking

Listen for state updates from the server:

```typescript
agent.runAgent({ messages }).subscribe({
  next: (event) => {
    if (event.type === "STATE_SNAPSHOT") {
      console.log("Server state:", event.state);
      // Update your UI with new state
    }
  }
});
```

### Cloning Agents

Create a new instance with the same configuration:

```typescript
const agent1 = new CloudflareAgentsClient({ url: "wss://..." });
const agent2 = agent1.clone(); // Same config, fresh state

// Both can run independently
agent1.runAgent({ messages: [...] });
agent2.runAgent({ messages: [...] });
```

### Aborting Runs

```typescript
const agent = new CloudflareAgentsClient({ url: "wss://..." });

// Start a run
const subscription = agent.runAgent({ messages }).subscribe(...);

// Abort via agent
agent.abortRun(); // Closes WebSocket, emits RUN_FINISHED, completes observable

// OR abort via subscription
subscription.unsubscribe(); // Same effect
```

## Connection Lifecycle

```
new CloudflareAgentsClient() → Not connected
  ↓
runAgent() → Connecting
  ↓
WebSocket Open → Connected
  ↓
Send INIT message
  ↓
Receive events → Processing
  ↓
WebSocket Close → RUN_FINISHED
  ↓
Observable Complete
```

## Security

### URL Validation

The client validates and normalizes URLs:

```typescript
// These are equivalent:
new CloudflareAgentsClient({ url: "https://worker.dev" });
new CloudflareAgentsClient({ url: "wss://worker.dev" });

// Both convert to: wss://worker.dev
```

### Event Listener Cleanup

The client properly removes event listeners on cleanup to prevent memory leaks:

- When observable completes
- When observable errors
- When subscription is unsubscribed

## Troubleshooting

### "WebSocket not available" Error

**Cause**: Running in Node.js without `ws` package.

**Solution**:
```bash
npm install ws
```

```typescript
import WebSocket from "ws";
globalThis.WebSocket = WebSocket;
```

### Connection Closes Immediately

**Cause**: Server might not be handling WebSocket upgrade properly.

**Solution**: Ensure your Cloudflare Worker uses `routeAgentRequest()` from the Agents SDK.

### No Events Received

**Cause**: Server might not be sending AG-UI compatible events.

**Solution**: Use `AgentsToAGUIAdapter` on the server side to convert Vercel AI SDK streams to AG-UI events.

### Parse Errors

**Cause**: Server sending non-JSON or malformed messages.

**Solution**: Check server logs. All messages must be valid JSON strings.

## API Reference

### Constructor

```typescript
new CloudflareAgentsClient(config: CloudflareAgentsClientConfig)
```

**Config:**
- `url: string` - WebSocket URL to deployed Cloudflare Agent
- `agentId?: string` - Optional agent identifier
- `description?: string` - Optional agent description
- `threadId?: string` - Optional thread ID
- `initialMessages?: Message[]` - Optional initial messages
- `initialState?: any` - Optional initial state
- `debug?: boolean` - Enable debug logging

### Methods

#### `run(input: RunAgentInput): Observable<BaseEvent>`

Connect to agent and stream events.

**Parameters:**
- `input.messages: Message[]` - Message history
- `input.threadId?: string` - Thread ID
- `input.runId?: string` - Run ID
- `input.parentRunId?: string` - Parent run ID for branching
- `input.state?: any` - Initial state
- `input.tools?: Tool[]` - Available tools
- `input.context?: any[]` - Additional context

**Returns:** Observable stream of AG-UI events

#### `abortRun(): void`

Abort the current run and close WebSocket connection.

#### `clone(): CloudflareAgentsClient`

Create a new instance with the same configuration.
