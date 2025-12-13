# @ag-ui/claude

Integration of Claude Agent SDK with AG-UI Protocol, enabling Claude agents to work seamlessly in AG-UI applications.

## Features

- ✅ **Full AG-UI Protocol Support** - Implements all standard event types
- ✅ **Persistent Session Management** - Supports multi-turn conversations and session state maintenance
- ✅ **Tool Integration** - Supports both client-side and backend tools
- ✅ **Streaming Responses** - Real-time streaming of AI responses
- ✅ **Stateless Mode** - Optional stateless execution mode
- ✅ **TypeScript Support** - Complete type definitions
- ✅ **Observable API** - RxJS Observable-based event streams
- ✅ **Automatic Session Cleanup** - Automatically cleans up expired sessions

## Installation

```bash
npm install @ag-ui/claude @ag-ui/client @ag-ui/core
```

You also need to install Claude Agent SDK:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## Quick Start

### Basic Usage

```typescript
import { ClaudeAgent } from '@ag-ui/claude';
import type { RunAgentInput } from '@ag-ui/client';

// Initialize agent
const agent = new ClaudeAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  enablePersistentSessions: true,
});

// Prepare input
const input: RunAgentInput = {
  agentId: 'my_agent',
  threadId: 'thread_123',
  messages: [
    { id: 'msg_1', role: 'user', content: 'Hello!' },
  ],
  context: {},
};

// Run agent and subscribe to events
agent.run(input).subscribe({
  next: (event) => {
    console.log('Event:', event);
  },
  error: (error) => {
    console.error('Error:', error);
  },
  complete: () => {
    console.log('Done!');
  },
});
```

### Using Tools

```typescript
import { ClaudeAgent } from '@ag-ui/claude';

const agent = new ClaudeAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const input: RunAgentInput = {
  agentId: 'my_agent',
  messages: [
    { id: 'msg_1', role: 'user', content: 'Calculate 42 + 58' },
  ],
  context: {
    tools: [
      {
        name: 'calculator',
        description: 'Performs calculations',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['operation', 'a', 'b'],
        },
        handler: async ({ operation, a, b }) => {
          // Backend tool implementation
          if (operation === 'add') return a + b;
          // ...
        },
      },
    ],
  },
};

agent.run(input).subscribe({
  next: (event) => {
    if (event.type === 'tool_call_start') {
      console.log('Tool called:', event.toolName);
    }
  },
});
```

### Express Server Example

```typescript
import express from 'express';
import { ClaudeAgent } from '@ag-ui/claude';

const app = express();
app.use(express.json());

const agent = new ClaudeAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.post('/api/run-agent', async (req, res) => {
  const input: RunAgentInput = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  agent.run(input).subscribe({
    next: (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    error: (error) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    },
    complete: () => {
      res.end();
    },
  });
});

app.listen(3000);
```

## API Documentation

### ClaudeAgent

Main agent class that extends `AbstractAgent`.

#### Constructor

```typescript
constructor(config: ClaudeAgentConfig)
```

**Configuration Options:**

- `apiKey?: string` - Anthropic API key (defaults to `ANTHROPIC_API_KEY` environment variable)
- `baseUrl?: string` - API base URL (defaults to `ANTHROPIC_BASE_URL` environment variable)
- `enablePersistentSessions?: boolean` - Whether to enable persistent sessions (default: `true`)
- `sessionTimeout?: number` - Session timeout in milliseconds (default: 30 minutes)
- `permissionMode?: 'ask' | 'auto' | 'none'` - Permission mode (default: `'ask'`)

#### Methods

##### `run(input: RunAgentInput): Observable<ProcessedEvents>`

Runs the agent and returns an Observable of event streams.

**Parameters:**
- `input.agentId: string` - Agent ID
- `input.threadId?: string` - Session ID (for persistent sessions)
- `input.messages: Message[]` - Message history
- `input.context?: { tools?: Tool[] }` - Context (including tool definitions)

**Returns:** Observable that emits AG-UI Protocol events

##### `abortExecution(runId: string): void`

Aborts a running execution.

##### `cleanup(): Promise<void>`

Cleans up all sessions and resources.

### SessionManager

Session manager using singleton pattern.

#### Methods

- `getInstance(sessionTimeout?: number): SessionManager` - Get singleton instance
- `getSession(sessionId: string, userId?: string): Session` - Get or create session
- `hasSession(sessionId: string): boolean` - Check if session exists
- `deleteSession(sessionId: string): boolean` - Delete session
- `trackMessage(sessionId: string, messageId: string): void` - Mark message as processed
- `getUnseenMessages(sessionId: string, messages: Message[]): Message[]` - Get unprocessed messages
- `getStateValue(sessionId: string, key: string): any` - Get session state value
- `setStateValue(sessionId: string, key: string, value: any): void` - Set session state value

### EventTranslator

Event translator that converts Claude SDK messages to AG-UI events.

#### Methods

- `translateMessage(message: SDKMessage): ProcessedEvents[]` - Translate a single message

### ToolAdapter

Tool adapter that handles tool format conversion.

#### Static Methods

- `convertAgUiToolsToSdk(tools: Tool[]): SdkMcpToolDefinition[]` - Convert tools to SDK format
- `createMcpServerForTools(tools: Tool[]): McpSdkServerConfigWithInstance` - Create MCP server
- `formatToolNameForSdk(toolName: string, serverName?: string): string` - Format tool name
- `parseToolNameFromSdk(sdkToolName: string): string` - Parse tool name

## Event Types

The agent emits the following AG-UI Protocol events:

- `RunStartedEvent` - Execution started
- `RunFinishedEvent` - Execution completed
- `RunErrorEvent` - Execution error
- `StepStartedEvent` - Step started
- `StepFinishedEvent` - Step completed
- `TextMessageStartEvent` - Text message started
- `TextMessageContentEvent` - Text message content (streaming)
- `TextMessageEndEvent` - Text message ended
- `ToolCallStartEvent` - Tool call started
- `ToolCallArgsEvent` - Tool arguments
- `ToolCallEndEvent` - Tool call ended
- `ToolCallResultEvent` - Tool execution result

## Tool Support

### Backend Tools

Backend tools are executed on the server side:

```typescript
{
  name: 'calculator',
  description: 'Performs calculations',
  parameters: { /* JSON Schema */ },
  handler: async (args) => {
    // Tool logic
    return result;
  }
}
```

### Client Tools

Client tools are executed on the frontend. Set `client: true`:

```typescript
{
  name: 'file_reader',
  description: 'Reads files',
  client: true,
  parameters: { /* JSON Schema */ }
}
```

## Session Management

### Persistent Session Mode

When persistent sessions are enabled, the agent maintains independent sessions for each `threadId`:

```typescript
const agent = new ClaudeAgent({
  apiKey: 'your_key',
  enablePersistentSessions: true,
  sessionTimeout: 30 * 60 * 1000, // 30 minutes
});
```

### Stateless Mode

When persistent sessions are disabled, each call is independent:

```typescript
const agent = new ClaudeAgent({
  apiKey: 'your_key',
  enablePersistentSessions: false,
});
```

## Testing

Run unit tests:

```bash
npm test
```

Run specific tests:

```bash
npm test -- agent.test.ts
```

## Examples

See the `examples/` directory for complete examples:

- **Express Server** - Complete Express.js server example
- **Tool Integration** - Backend and client tool examples
- **Session Management** - Multi-turn conversation examples

## Architecture

The integration architecture is based on the Python version:

```
AG-UI Protocol          Claude Middleware          Claude Agent SDK
     │                        │                           │
RunAgentInput ──────> ClaudeAgent.run() ──────> SDK Client/Query
     │                        │                           │
     │                 EventTranslator                    │
     │                        │                           │
BaseEvent[] <──────── translate events <──────── Response[]
```

Key Components:

- **ClaudeAgent**: Main coordinator, manages execution flow
- **EventTranslator**: Event translation (Claude SDK → AG-UI)
- **SessionManager**: Session lifecycle management
- **ToolAdapter**: Tool format conversion
- **ExecutionState**: Execution state tracking

## References

- [Python Implementation](../python/) - Python SDK implementation reference
- [Claude Agent SDK Documentation](https://docs.claude.com/api/agent-sdk/typescript)
- [AG-UI Protocol Documentation](https://docs.ag-ui.com/)

## License

Apache-2.0
