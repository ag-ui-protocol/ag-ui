---
name: agui-text-message-events
description: >
  Emit and handle streaming text messages using TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT,
  TEXT_MESSAGE_END events or the TEXT_MESSAGE_CHUNK convenience event. Manage messageId
  consistency, non-empty delta validation, and message role types.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/events.ts
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/client/src/chunks/transform.ts
  - ag-ui-protocol/ag-ui:docs/concepts/events.mdx
requires:
  - agui-run-lifecycle
---

# AG-UI -- Text Message Events

## Setup

Minimum imports for text message streaming:

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageChunkEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
```

Minimal streaming text message within a run:

```typescript
function streamTextMessage(
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
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    } as TextMessageStartEvent);

    subscriber.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "Hello, ",
    } as TextMessageContentEvent);

    subscriber.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "world!",
    } as TextMessageContentEvent);

    subscriber.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

## Core Patterns

### Pattern 1: Explicit START/CONTENT/END (Recommended)

The explicit pattern gives full control over message lifecycle. Each event
references the same messageId. The role is set on START and defaults to
"assistant". Valid roles for text messages: "developer", "system",
"assistant", "user".

```typescript
import {
  EventType,
  BaseEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";
import { Subscriber } from "rxjs";

function emitExplicitTextMessage(
  subscriber: Subscriber<BaseEvent>,
  messageId: string,
  chunks: string[],
  role: "developer" | "system" | "assistant" | "user" = "assistant",
): void {
  subscriber.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId,
    role,
  } as TextMessageStartEvent);

  for (const chunk of chunks) {
    if (chunk.length > 0) {
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: chunk,
      } as TextMessageContentEvent);
    }
  }

  subscriber.next({
    type: EventType.TEXT_MESSAGE_END,
    messageId,
  } as TextMessageEndEvent);
}
```

### Pattern 2: TEXT_MESSAGE_CHUNK Convenience Event

CHUNK events auto-expand to START/CONTENT/END via the client's chunk
transformer. The first chunk for a message MUST include messageId.
Subsequent chunks for the same message can omit messageId. The message
auto-closes when the stream switches to a different messageId, a different
event type, or when the stream completes.

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageChunkEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function streamWithChunks(
  threadId: string,
  runId: string,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

    // First chunk: messageId required, role optional (defaults to "assistant")
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-1",
      role: "assistant",
      delta: "Hello, ",
    } as TextMessageChunkEvent);

    // Subsequent chunks: messageId optional for same message
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      delta: "world!",
    } as TextMessageChunkEvent);

    // Starting a new messageId auto-closes "msg-1"
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "msg-2",
      delta: "Second message.",
    } as TextMessageChunkEvent);

    // RUN_FINISHED auto-closes any pending chunk message
    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

### Pattern 3: Multiple Messages in a Single Run

Multiple text messages can be emitted within one run. Each must be
fully closed (END) before starting the next when using explicit events.

```typescript
import {
  EventType,
  BaseEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";
import { Subscriber } from "rxjs";

function emitMultipleMessages(subscriber: Subscriber<BaseEvent>): void {
  // Message 1: assistant
  subscriber.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId: "msg-1",
    role: "assistant",
  } as TextMessageStartEvent);
  subscriber.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "msg-1",
    delta: "Let me think about that...",
  } as TextMessageContentEvent);
  subscriber.next({
    type: EventType.TEXT_MESSAGE_END,
    messageId: "msg-1",
  } as TextMessageEndEvent);

  // Message 2: assistant (different messageId)
  subscriber.next({
    type: EventType.TEXT_MESSAGE_START,
    messageId: "msg-2",
    role: "assistant",
  } as TextMessageStartEvent);
  subscriber.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "msg-2",
    delta: "Here is the answer.",
  } as TextMessageContentEvent);
  subscriber.next({
    type: EventType.TEXT_MESSAGE_END,
    messageId: "msg-2",
  } as TextMessageEndEvent);
}
```

### Pattern 4: Named Messages

The optional `name` field on TEXT_MESSAGE_START identifies the sender
within a role (useful for multi-agent setups).

```typescript
import {
  EventType,
  TextMessageStartEvent,
} from "@ag-ui/core";

const namedMessage: TextMessageStartEvent = {
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg-1",
  role: "assistant",
  name: "research-agent",
};
```

## Common Mistakes

### 1. Empty delta in TEXT_MESSAGE_CONTENT (HIGH)

The Zod schema enforces `delta` must be a non-empty string. Empty string
causes validation failure: "Delta must not be an empty string".

```typescript
// WRONG: empty delta
subscriber.next({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-1",
  delta: "",
} as TextMessageContentEvent);
```

```typescript
// CORRECT: guard against empty strings
const text = getNextChunk();
if (text.length > 0) {
  subscriber.next({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "msg-1",
    delta: text,
  } as TextMessageContentEvent);
}
```

### 2. Missing messageId in first TEXT_MESSAGE_CHUNK (CRITICAL)

The chunk transformer throws "First TEXT_MESSAGE_CHUNK must have a messageId"
if the first chunk for a new message omits messageId.

```typescript
// WRONG: first chunk without messageId
subscriber.next({
  type: EventType.TEXT_MESSAGE_CHUNK,
  delta: "Hello",
} as TextMessageChunkEvent);
```

```typescript
// CORRECT: first chunk includes messageId
subscriber.next({
  type: EventType.TEXT_MESSAGE_CHUNK,
  messageId: "msg-1",
  delta: "Hello",
} as TextMessageChunkEvent);
```

### 3. Mismatched messageId between START and CONTENT (HIGH)

The verifier tracks active messages by messageId. Content events with a
different messageId than the active START fail with "No active text message
found with ID".

```typescript
// WRONG: content references wrong messageId
subscriber.next({
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg-1",
  role: "assistant",
} as TextMessageStartEvent);
subscriber.next({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-2",
  delta: "Hello",
} as TextMessageContentEvent); // Throws!
```

```typescript
// CORRECT: all events share the same messageId
subscriber.next({
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg-1",
  role: "assistant",
} as TextMessageStartEvent);
subscriber.next({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-1",
  delta: "Hello",
} as TextMessageContentEvent);
```

### 4. Mixing CHUNK events with explicit START/CONTENT/END (HIGH)

Chunk events auto-transform to START/CONTENT/END sequences. Mixing both
patterns for the same message causes double-initialization or orphaned events.
Use one pattern per message.

```typescript
// WRONG: mixing chunk and explicit for same message
subscriber.next({
  type: EventType.TEXT_MESSAGE_CHUNK,
  messageId: "msg-1",
  delta: "Hello ",
} as TextMessageChunkEvent);
subscriber.next({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-1",
  delta: "world",
} as TextMessageContentEvent); // Breaks: chunk transformer already managing this message
```

```typescript
// CORRECT: use one pattern consistently per message
// Option A: all chunks
subscriber.next({
  type: EventType.TEXT_MESSAGE_CHUNK,
  messageId: "msg-1",
  delta: "Hello ",
} as TextMessageChunkEvent);
subscriber.next({
  type: EventType.TEXT_MESSAGE_CHUNK,
  delta: "world",
} as TextMessageChunkEvent);

// Option B: all explicit
subscriber.next({
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg-1",
  role: "assistant",
} as TextMessageStartEvent);
subscriber.next({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-1",
  delta: "Hello world",
} as TextMessageContentEvent);
subscriber.next({
  type: EventType.TEXT_MESSAGE_END,
  messageId: "msg-1",
} as TextMessageEndEvent);
```

See also: agui-run-lifecycle, agui-tool-calling-events, agui-state-synchronization
