---
name: agui-implement-abstract-agent
description: >
  Implement the AbstractAgent interface for a new framework by subclassing
  AbstractAgent, returning an Observable<BaseEvent> from run(), emitting events
  in correct lifecycle order, and converting framework messages to AG-UI format.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/client/src/agent/agent.ts
  - ag-ui-protocol/ag-ui:docs/concepts/agents.mdx
  - ag-ui-protocol/ag-ui:integrations/mastra/typescript/src/mastra.ts
---

# AG-UI — Implement AbstractAgent

## Setup

Minimum viable agent that compiles and passes the event verifier:

```typescript
import { AbstractAgent } from "@ag-ui/client";
import {
  RunAgentInput,
  BaseEvent,
  EventType,
} from "@ag-ui/core";
import { Observable } from "rxjs";

class MinimalAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });

      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      });

      subscriber.complete();
    });
  }
}
```

Install dependencies:

```bash
pnpm add @ag-ui/client @ag-ui/core rxjs
```

## Core Patterns

### Pattern 1: Streaming text response with correct lifecycle

Every agent run must follow this event ordering:
`RUN_STARTED` -> (content events) -> `RUN_FINISHED` -> `subscriber.complete()`

All text message streams and tool call streams must be closed before `RUN_FINISHED`.

```typescript
import { AbstractAgent } from "@ag-ui/client";
import {
  RunAgentInput,
  BaseEvent,
  EventType,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunStartedEvent,
  RunFinishedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
import { v4 as uuidv4 } from "uuid";

class StreamingTextAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        try {
          const { threadId, runId } = input;
          const messageId = uuidv4();

          subscriber.next({
            type: EventType.RUN_STARTED,
            threadId,
            runId,
          } as RunStartedEvent);

          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          } as TextMessageStartEvent);

          // Simulate streaming chunks from an LLM
          const chunks = ["Hello", ", ", "world", "!"];
          for (const chunk of chunks) {
            subscriber.next({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: chunk,
            } as TextMessageContentEvent);
          }

          // MUST close the message before RUN_FINISHED
          subscriber.next({
            type: EventType.TEXT_MESSAGE_END,
            messageId,
          } as TextMessageEndEvent);

          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
          } as RunFinishedEvent);

          // MUST complete the Observable or runAgent() never resolves
          subscriber.complete();
        } catch (error) {
          subscriber.error(error);
        }
      };

      run();
    });
  }
}
```

### Pattern 2: Converting framework messages to AG-UI format

`RunAgentInput.messages` is an array of AG-UI `Message` objects. When integrating
with an LLM framework, convert these to the framework's format before calling the
LLM, then convert the LLM's output back to AG-UI events.

```typescript
import { AbstractAgent } from "@ag-ui/client";
import {
  RunAgentInput,
  BaseEvent,
  EventType,
  Message,
} from "@ag-ui/core";
import { Observable } from "rxjs";
import { v4 as uuidv4 } from "uuid";

// Example: converting AG-UI messages to a generic LLM format
function convertToLLMMessages(messages: Message[]): Array<{ role: string; content: string }> {
  return messages
    .filter((m) => m.role !== "activity") // Never forward activity messages
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "system",
      content: typeof m.content === "string" ? m.content : "",
    }));
}

class LLMIntegrationAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const run = async () => {
        try {
          const { threadId, runId, messages, tools } = input;
          const messageId = uuidv4();

          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

          const llmMessages = convertToLLMMessages(messages);
          // const stream = await yourLLM.stream(llmMessages, { tools });

          subscriber.next({
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          });

          // Process each chunk from LLM stream
          // for await (const chunk of stream) {
          //   if (chunk.text) {
          //     subscriber.next({
          //       type: EventType.TEXT_MESSAGE_CONTENT,
          //       messageId,
          //       delta: chunk.text,
          //     });
          //   }
          // }

          subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId });
          subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
          subscriber.complete();
        } catch (error) {
          subscriber.error(error);
        }
      };

      run();
    });
  }
}
```

### Pattern 3: RunAgentInput structure

`RunAgentInput` is the argument to `run()`. It contains everything the agent needs:

```typescript
interface RunAgentInput {
  threadId: string;       // Conversation thread identifier
  runId: string;          // Unique ID for this run
  messages: Message[];    // Conversation history (activity messages filtered out)
  tools: Tool[];          // Frontend-defined tools the agent can call
  context: Context[];     // Additional context provided by the frontend
  forwardedProps: Record<string, any>; // Arbitrary props forwarded from the frontend
  state: State;           // Current state object
}
```

`AbstractAgent.prepareRunAgentInput()` auto-generates `threadId` and `runId` if
not provided, clones all fields, and filters out activity messages. You do NOT
need to do this yourself inside `run()`.

### Pattern 4: Running the agent from client code

```typescript
const agent = new StreamingTextAgent({
  threadId: "thread-1",
  initialMessages: [
    { id: "msg-1", role: "user", content: "Hello" },
  ],
});

// runAgent() returns a Promise that resolves when the Observable completes
const { result, newMessages } = await agent.runAgent({
  tools: [],
});

// agent.messages now includes the assistant's response
// newMessages contains only messages added during this run
```

## Common Mistakes

### 1. Emitting events before RUN_STARTED (CRITICAL)

The event verifier enforces that the first event must be `RUN_STARTED`. Any event emitted before it throws an error.

Wrong:

```typescript
run(input: RunAgentInput): Observable<BaseEvent> {
  return new Observable((subscriber) => {
    subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "1" });
    subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
  });
}
```

Correct:

```typescript
run(input: RunAgentInput): Observable<BaseEvent> {
  return new Observable((subscriber) => {
    subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
    subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "1" });
  });
}
```

### 2. Not calling subscriber.complete() after RUN_FINISHED (CRITICAL)

The Observable stays open indefinitely, causing memory leaks and `runAgent()` never resolves.

Wrong:

```typescript
subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
// Missing: subscriber.complete()
```

Correct:

```typescript
subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
subscriber.complete();
```

### 3. Returning a plain value instead of Observable (CRITICAL)

`run()` must return `Observable<BaseEvent>`, not a Promise or array. The middleware chain and subscriber system depend on the Observable interface.

Wrong:

```typescript
async run(input: RunAgentInput): Promise<BaseEvent[]> {
  return [runStarted, textMessage, runFinished];
}
```

Correct:

```typescript
run(input: RunAgentInput): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next(runStarted);
    subscriber.next(textMessage);
    subscriber.next(runFinished);
    subscriber.complete();
  });
}
```

### 4. Emitting RUN_FINISHED with active messages or tool calls (HIGH)

The verifier checks that all `TEXT_MESSAGE` and `TOOL_CALL` streams are closed before `RUN_FINISHED`. Throws an error listing active IDs.

Wrong:

```typescript
subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "1" });
subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "1", delta: "Hello" });
// Missing TEXT_MESSAGE_END
subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
```

Correct:

```typescript
subscriber.next({ type: EventType.TEXT_MESSAGE_START, messageId: "1" });
subscriber.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "1", delta: "Hello" });
subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId: "1" });
subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
```

### 5. Not handling async errors inside Observable (HIGH)

Unhandled promise rejections inside the Observable constructor cause silent failures. Must call `subscriber.error()` in catch blocks.

Wrong:

```typescript
return new Observable((subscriber) => {
  const run = async () => {
    const response = await llm.stream(messages);
    // If this throws, the error is lost
  };
  run();
});
```

Correct:

```typescript
return new Observable((subscriber) => {
  const run = async () => {
    try {
      const response = await llm.stream(messages);
    } catch (error) {
      subscriber.error(error);
    }
  };
  run();
});
```

### 6. Over-implementing all AbstractAgent methods (HIGH)

AI agents tend to implement every possible method (`getCapabilities`, `connect`, etc.) with placeholder values instead of focusing on what is actually needed. This produces bloated implementations where capabilities are declared that the agent does not actually support.

`AbstractAgent` only requires one method: `run()`. `getCapabilities()` is optional. `connect()` is only for `connectAgent()` use cases. Do not implement methods you do not need.

Wrong:

```typescript
class MyAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> { /* ... */ }

  // Unnecessary - only implement if you actually support connectAgent()
  protected connect(input: RunAgentInput): Observable<BaseEvent> {
    throw new Error("Not implemented");
  }

  // Unnecessary - only implement if you have real capabilities to declare
  async getCapabilities() {
    return {
      identity: { name: "my-agent" },
      transport: { sse: true, websocket: false },
      tools: { clientProvided: false },
    };
  }
}
```

Correct:

```typescript
class MyAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> { /* ... */ }
  // Only implement other methods when you have a concrete need
}
```

See also: `agui-run-lifecycle`, `agui-text-message-events`, `agui-middleware`
