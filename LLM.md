
Comprehensive API documentation for the ag-ui repository covering TypeScript SDK, Python SDK, and all integrations.

## Core TypeScript SDK

### @ag-ui/core
Core types and events for the Agent User Interaction Protocol.

```typescript
import { Message, ToolCall, RunAgentInput, EventType } from '@ag-ui/core';
```

**Key Types:**
- `Message` - Union of all message types (DeveloperMessage, SystemMessage, AssistantMessage, UserMessage, ToolMessage)
- `ToolCall` - Function call with id, type, and function details
- `RunAgentInput` - Input for running an agent (threadId, runId, state, messages, tools, context)
- `State` - Any JSON-serializable state object
- `Context` - Additional context with description and value
- `Tool` - Tool definition with name, description, and JSON schema parameters

**Key Events:**
- `EventType` - Enum of all event types (TEXT_MESSAGE_START, TOOL_CALL_START, RUN_STARTED, etc.)
- `BaseEvent` - Base event interface with type and timestamp
- `TextMessageChunkEvent` - Streaming text content
- `ToolCallStartEvent` - Tool execution started
- `RunStartedEvent` - Agent run initiated
- `RunFinishedEvent` - Agent run completed

### @ag-ui/client
HTTP client for connecting to AG-UI agents.

```typescript
import { HttpAgent, AgentConfig, RunAgentParameters } from '@ag-ui/client';
```

**HttpAgent** - HTTP-based agent implementation
```typescript
const agent = new HttpAgent({
  url: 'http://localhost:3000/api/agents/chat',
  headers: { 'Authorization': 'Bearer token' }
});

const result = await agent.runAgent({
  tools: [...],
  context: [...]
});
```

**Key Exports:**
- `HttpAgent` - HTTP client for remote agents
- `AbstractAgent` - Base class for custom agents
- `AgentConfig` - Configuration for agent initialization
- `RunAgentParameters` - Parameters for agent execution

### @ag-ui/proto
Protocol buffer encoding/decoding.

```typescript
import { encode, decode, AGUI_MEDIA_TYPE } from '@ag-ui/proto';
```

**Key Functions:**
- `encode(events: BaseEvent[]) => Uint8Array` - Encode events to protobuf
- `decode(data: Uint8Array) => BaseEvent[]` - Decode protobuf to events
- `AGUI_MEDIA_TYPE` - "application/vnd.ag-ui.event+proto"

### @ag-ui/encoder
Event encoder for media type handling.

```typescript
import { EventEncoder, AGUI_MEDIA_TYPE } from '@ag-ui/encoder';
```

**EventEncoder** - Encode/decode events with media type support
```typescript
const encoder = new EventEncoder();
const encoded = encoder.encode(events);
const decoded = encoder.decode(encoded);
```

## Python SDK

### ag_ui.core
Core types and events for Python.

```python
from ag_ui.core import (
    Message, ToolCall, RunAgentInput, EventType,
    TextMessageChunkEvent, ToolCallStartEvent
)
```

**Key Classes:**
- `Message` - Pydantic model for all message types
- `ToolCall` - Tool call with validation
- `RunAgentInput` - Input model for agent execution
- `EventType` - Enum of all event types

### ag_ui.encoder
Event encoder for Python.

```python
from ag_ui.encoder import EventEncoder, AGUI_MEDIA_TYPE

encoder = EventEncoder()
encoded = encoder.encode(events)
decoded = encoder.decode(encoded)
```

## Integration Packages

### LangGraph Integration
```typescript
import { LangGraphHttpAgent } from '@ag-ui/langgraph';

const agent = new LangGraphHttpAgent({
  url: 'http://localhost:8000/agent',
  threadId: 'user-123'
});
```

### CrewAI Integration
```typescript
import { CrewAIAgent } from '@ag-ui/crewai';

const agent = new CrewAIAgent({
  url: 'http://localhost:8000/crew',
  headers: { 'X-API-Key': 'secret' }
});
```

### LlamaIndex Integration
```typescript
import { LlamaIndexAgent } from '@ag-ui/llamaindex';

const agent = new LlamaIndexAgent({
  url: 'http://localhost:8000/llamaindex',
  description: 'LlamaIndex agent with RAG'
});
```

### Mastra Integration
```typescript
import { MastraAgent } from '@ag-ui/mastra';
import { Agent as LocalMastraAgent } from '@mastra/core/agent';

// Local Mastra agent
const mastraAgent = new LocalMastraAgent({
  name: 'weather-agent',
  instructions: 'You are a weather assistant',
  model: openai('gpt-4'),
  tools: { weatherTool }
});

const agent = new MastraAgent({
  agent: mastraAgent,
  resourceId: 'user-123'
});

// Remote Mastra agent
const remoteAgent = new MastraAgent({
  agent: mastraClient.getAgent('weather-agent'),
  resourceId: 'user-123'
});
```

### Vercel AI SDK Integration
```typescript
import { VercelAISDKAgent } from '@ag-ui/vercel-ai-sdk';
import { openai } from '@ai-sdk/openai';

const agent = new VercelAISDKAgent({
  model: openai('gpt-4-turbo'),
  maxSteps: 5,
  toolChoice: 'auto'
});
```

### Agno Integration
```typescript
import { AgnoAgent } from '@ag-ui/agno';

const agent = new AgnoAgent({
  url: 'http://localhost:8000/agno',
  description: 'Multi-agent system'
});
```

## Usage Patterns

### Basic HTTP Agent
```typescript
import { HttpAgent } from '@ag-ui/client';

const agent = new HttpAgent({
  url: 'http://localhost:3000/api/agent',
  threadId: 'user-session-123'
});

const { result, newMessages } = await agent.runAgent({
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' }
        }
      }
    }
  ],
  context: [
    {
      description: 'User preferences',
      value: JSON.stringify({ timezone: 'UTC' })
    }
  ]
});
```

### Custom Agent Implementation
```typescript
import { AbstractAgent, RunAgentInput, BaseEvent } from '@ag-ui/client';
import { Observable, of } from 'rxjs';

class MyCustomAgent extends AbstractAgent {
  protected run(input: RunAgentInput): Observable<BaseEvent> {
    // Custom agent logic here
    return of({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: 'msg-123',
      delta: 'Hello from custom agent'
    });
  }
}
```

### Python Usage
```python
from ag_ui.core import RunAgentInput, Tool, Message
from ag_ui.encoder import EventEncoder

# Create agent input
input_data = RunAgentInput(
    thread_id="user-123",
    run_id="run-456",
    state={"count": 0},
    messages=[Message(role="user", content="Hello")],
    tools=[Tool(name="search", description="Search tool", parameters={})],
    context=[],
    forwarded_props={}
)

# Encode events
encoder = EventEncoder()
events = [...]  # List of events
encoded = encoder.encode(events)
```

## Import Paths Summary

| Package | Import Path |
|---------|-------------|
| Core Types | `@ag-ui/core` |
| HTTP Client | `@ag-ui/client` |
| Protocol | `@ag-ui/proto` |
| Encoder | `@ag-ui/encoder` |
| LangGraph | `@ag-ui/langgraph` |
| CrewAI | `@ag-ui/crewai` |
| LlamaIndex | `@ag-ui/llamaindex` |
| Mastra | `@ag-ui/mastra` |
| Vercel AI | `@ag-ui/vercel-ai-sdk` |
| Agno | `@ag-ui/agno` |
| Python Core | `ag_ui.core` |
| Python Encoder | `ag_ui.encoder` |

## Environment Variables

Common environment variables used across integrations:
- `AG_UI_API_URL` - Base URL for HTTP agents
- `AG_UI_API_KEY` - API key for authentication
- `AG_UI_DEBUG` - Enable debug mode (true/false)
