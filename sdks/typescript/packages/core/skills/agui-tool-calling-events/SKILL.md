---
name: agui-tool-calling-events
description: >
  Implement tool call lifecycle: TOOL_CALL_START, TOOL_CALL_ARGS (JSON string fragments),
  TOOL_CALL_END, TOOL_CALL_RESULT. Define frontend tools with JSON Schema parameters.
  Use TOOL_CALL_CHUNK convenience event. Handle toolCallId consistency and result linking.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/events.ts
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/client/src/chunks/transform.ts
  - ag-ui-protocol/ag-ui:docs/concepts/tools.mdx
requires:
  - agui-run-lifecycle
---

# AG-UI -- Tool Calling Events

## Setup

Minimum imports for tool call events:

```typescript
import {
  EventType,
  BaseEvent,
  Tool,
  RunAgentInput,
  RunStartedEvent,
  RunFinishedEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallChunkEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
```

Defining a frontend tool with JSON Schema parameters:

```typescript
import { Tool } from "@ag-ui/core";

const weatherTool: Tool = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "City name",
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
      },
    },
    required: ["location"],
  },
};
```

## Core Patterns

### Pattern 1: Explicit TOOL_CALL_START/ARGS/END

The full tool call lifecycle streams arguments as JSON string fragments.
The concatenated ARGS deltas form a valid JSON string.

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function emitToolCall(
  threadId: string,
  runId: string,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

    subscriber.next({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: "msg-1",
    } as ToolCallStartEvent);

    // Stream arguments as JSON string fragments
    subscriber.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: '{"location":',
    } as ToolCallArgsEvent);

    subscriber.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: ' "London",',
    } as ToolCallArgsEvent);

    subscriber.next({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tc-1",
      delta: ' "unit": "celsius"}',
    } as ToolCallArgsEvent);

    subscriber.next({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tc-1",
    } as ToolCallEndEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

### Pattern 2: TOOL_CALL_RESULT

After the frontend executes the tool, it returns the result via
TOOL_CALL_RESULT. The result links back to the original tool call
via toolCallId. The content field is a string (typically JSON).

```typescript
import {
  EventType,
  ToolCallResultEvent,
} from "@ag-ui/core";

const result: ToolCallResultEvent = {
  type: EventType.TOOL_CALL_RESULT,
  messageId: "result-1",
  toolCallId: "tc-1",
  content: JSON.stringify({
    temperature: 18,
    condition: "Cloudy",
    humidity: 72,
  }),
  role: "tool",
};
```

### Pattern 3: TOOL_CALL_CHUNK Convenience Event

CHUNK events auto-expand to START/ARGS/END via the client's chunk
transformer. The first chunk MUST include both toolCallId and
toolCallName. The tool call auto-closes when the stream switches
to a different toolCallId or a different event type.

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  ToolCallChunkEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function streamWithToolChunks(
  threadId: string,
  runId: string,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

    // First chunk: toolCallId and toolCallName required
    subscriber.next({
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tc-1",
      toolCallName: "get_weather",
      parentMessageId: "msg-1",
      delta: '{"location": "London"',
    } as ToolCallChunkEvent);

    // Subsequent chunks: toolCallId optional for same call
    subscriber.next({
      type: EventType.TOOL_CALL_CHUNK,
      delta: ', "unit": "celsius"}',
    } as ToolCallChunkEvent);

    // Switching to a new toolCallId auto-closes tc-1
    subscriber.next({
      type: EventType.TOOL_CALL_CHUNK,
      toolCallId: "tc-2",
      toolCallName: "get_forecast",
      delta: '{"location": "London", "days": 3}',
    } as ToolCallChunkEvent);

    // RUN_FINISHED auto-closes any pending chunk tool call
    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

### Pattern 4: Tool Definition in RunAgentInput

Frontend-defined tools are passed to the agent via RunAgentInput.tools.
The agent uses these definitions to decide which tools to call and
how to format arguments.

```typescript
import { RunAgentInput, Tool } from "@ag-ui/core";

const tools: Tool[] = [
  {
    name: "get_weather",
    description: "Get current weather for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["location"],
    },
  },
  {
    name: "search_docs",
    description: "Search documentation for a query",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
  },
];

const input: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-1",
  state: {},
  messages: [],
  tools,
  context: [],
  forwardedProps: {},
};
```

## Common Mistakes

### 1. Tool arguments as parsed object instead of JSON string (CRITICAL)

TOOL_CALL_ARGS delta must be a JSON string fragment, not a parsed object.
The deltas are concatenated as strings to form valid JSON.

```typescript
// WRONG: object instead of string
subscriber.next({
  type: EventType.TOOL_CALL_ARGS,
  toolCallId: "tc-1",
  delta: { city: "London" } as any, // Wrong: object
} as ToolCallArgsEvent);
```

```typescript
// CORRECT: JSON string fragment
subscriber.next({
  type: EventType.TOOL_CALL_ARGS,
  toolCallId: "tc-1",
  delta: '{"city": "London"}',
} as ToolCallArgsEvent);
```

### 2. Missing toolCallName in first TOOL_CALL_CHUNK (CRITICAL)

The chunk transformer throws "First TOOL_CALL_CHUNK must have a
toolCallName" if the first chunk omits the tool name.

```typescript
// WRONG: first chunk without toolCallName
subscriber.next({
  type: EventType.TOOL_CALL_CHUNK,
  toolCallId: "tc-1",
  delta: '{"x":1}',
} as ToolCallChunkEvent);
```

```typescript
// CORRECT: first chunk includes both toolCallId and toolCallName
subscriber.next({
  type: EventType.TOOL_CALL_CHUNK,
  toolCallId: "tc-1",
  toolCallName: "get_weather",
  delta: '{"x":1}',
} as ToolCallChunkEvent);
```

### 3. Starting same toolCallId twice (HIGH)

The verifier throws "A tool call with ID ... is already in progress"
if TOOL_CALL_START is emitted with an already-active toolCallId.

```typescript
// WRONG: duplicate toolCallId
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-1",
  toolCallName: "get_weather",
} as ToolCallStartEvent);
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-1",
  toolCallName: "get_forecast",
} as ToolCallStartEvent); // Throws!
```

```typescript
// CORRECT: use unique toolCallIds or close the first before reusing
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-1",
  toolCallName: "get_weather",
} as ToolCallStartEvent);
subscriber.next({
  type: EventType.TOOL_CALL_END,
  toolCallId: "tc-1",
} as ToolCallEndEvent);
// Now tc-1 is closed; use a new ID for the next call
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-2",
  toolCallName: "get_forecast",
} as ToolCallStartEvent);
```

### 4. OpenAI tool description exceeds 1024 chars (MEDIUM)

OpenAI enforces a 1024 character limit for tool descriptions. Exceeding
it causes silent truncation or API errors. Gemini and Anthropic have
no such limit, but keep descriptions concise for interoperability.

```typescript
// WRONG: overly long description
const tool: Tool = {
  name: "analyze",
  description: "A".repeat(2000), // Too long for OpenAI
  parameters: { type: "object", properties: {} },
};
```

```typescript
// CORRECT: concise description under 1024 chars
const tool: Tool = {
  name: "analyze",
  description: "Analyze a document and return key findings with citations",
  parameters: { type: "object", properties: {} },
};
```

### 5. TOOL_CALL_RESULT without matching toolCallId (HIGH)

The result event must reference a toolCallId from a prior tool call.
Orphaned results create broken message history because there is no
matching tool call in the conversation for the result to attach to.

```typescript
// WRONG: result references nonexistent tool call
subscriber.next({
  type: EventType.TOOL_CALL_RESULT,
  messageId: "result-1",
  toolCallId: "tc-nonexistent",
  content: "some result",
} as ToolCallResultEvent);
```

```typescript
// CORRECT: result references a toolCallId that was actually started
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-1",
  toolCallName: "get_weather",
} as ToolCallStartEvent);
subscriber.next({
  type: EventType.TOOL_CALL_ARGS,
  toolCallId: "tc-1",
  delta: '{"location": "London"}',
} as ToolCallArgsEvent);
subscriber.next({
  type: EventType.TOOL_CALL_END,
  toolCallId: "tc-1",
} as ToolCallEndEvent);
// Result matches tc-1
subscriber.next({
  type: EventType.TOOL_CALL_RESULT,
  messageId: "result-1",
  toolCallId: "tc-1",
  content: '{"temperature": 18}',
} as ToolCallResultEvent);
```

See also: agui-run-lifecycle, agui-text-message-events, agui-human-in-the-loop
