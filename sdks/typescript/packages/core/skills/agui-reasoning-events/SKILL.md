---
name: agui-reasoning-events
description: >
  Surface LLM reasoning with REASONING_START/END, REASONING_MESSAGE_START/CONTENT/END,
  REASONING_MESSAGE_CHUNK, and REASONING_ENCRYPTED_VALUE events. Support ZDR compliance
  via encrypted reasoning values. Migrate from deprecated THINKING_* events.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/events.ts
  - ag-ui-protocol/ag-ui:docs/concepts/reasoning.mdx
requires:
  - agui-run-lifecycle
---

# AG-UI — Reasoning Events

Depends on `agui-run-lifecycle`. Reasoning events surface the LLM's internal thinking process with optional encryption for privacy compliance (ZDR, SOC 2, HIPAA).

## Setup

```typescript
import {
  EventType,
  type ReasoningStartEvent,
  type ReasoningMessageStartEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageChunkEvent,
  type ReasoningEndEvent,
  type ReasoningEncryptedValueEvent,
  type ReasoningEncryptedValueSubtype,
  type BaseEvent,
} from "@ag-ui/core";
import type { ReasoningMessage } from "@ag-ui/core";
```

## Core Patterns

### Pattern 1: Basic reasoning flow with explicit events

Every reasoning block must be wrapped in `REASONING_START`/`REASONING_END`. Inside, reasoning messages follow the same START/CONTENT/END pattern as text messages.

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitReasoning(
  subscriber: { next: (event: BaseEvent) => void },
  threadId: string,
  runId: string,
): void {
  subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

  // Begin reasoning phase
  subscriber.next({
    type: EventType.REASONING_START,
    messageId: "reasoning-001",
  });

  // Stream visible reasoning content
  subscriber.next({
    type: EventType.REASONING_MESSAGE_START,
    messageId: "rmsg-001",
    role: "reasoning" as const,
  });
  subscriber.next({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: "rmsg-001",
    delta: "Let me analyze the user's request. ",
  });
  subscriber.next({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: "rmsg-001",
    delta: "I should check the database first.",
  });
  subscriber.next({
    type: EventType.REASONING_MESSAGE_END,
    messageId: "rmsg-001",
  });

  // End reasoning phase
  subscriber.next({
    type: EventType.REASONING_END,
    messageId: "reasoning-001",
  });

  // Now emit the actual response...
  subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
}
```

### Pattern 2: REASONING_MESSAGE_CHUNK convenience event

The chunk event auto-manages message lifecycle, similar to `TEXT_MESSAGE_CHUNK`:

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitReasoningChunks(
  subscriber: { next: (event: BaseEvent) => void },
): void {
  subscriber.next({
    type: EventType.REASONING_START,
    messageId: "reasoning-002",
  });

  // First chunk with messageId starts the message automatically
  subscriber.next({
    type: EventType.REASONING_MESSAGE_CHUNK,
    messageId: "rmsg-002",
    delta: "Considering multiple approaches...",
  });

  // Subsequent chunks continue the stream
  subscriber.next({
    type: EventType.REASONING_MESSAGE_CHUNK,
    messageId: "rmsg-002",
    delta: " Option A seems more efficient.",
  });

  subscriber.next({
    type: EventType.REASONING_END,
    messageId: "reasoning-002",
  });
}
```

### Pattern 3: Encrypted reasoning for ZDR compliance

Use `REASONING_ENCRYPTED_VALUE` to attach opaque encrypted chain-of-thought to messages or tool calls. The client stores and forwards these blobs without decryption.

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitEncryptedReasoning(
  subscriber: { next: (event: BaseEvent) => void },
  encryptedBlob: string,
): void {
  subscriber.next({
    type: EventType.REASONING_START,
    messageId: "reasoning-003",
  });

  // Emit a visible summary only
  subscriber.next({
    type: EventType.REASONING_MESSAGE_START,
    messageId: "rmsg-003",
    role: "reasoning" as const,
  });
  subscriber.next({
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: "rmsg-003",
    delta: "Analyzing your request securely...",
  });
  subscriber.next({
    type: EventType.REASONING_MESSAGE_END,
    messageId: "rmsg-003",
  });

  // Attach encrypted chain-of-thought to the reasoning message
  // subtype: "message" for reasoning messages, "tool-call" for tool calls
  subscriber.next({
    type: EventType.REASONING_ENCRYPTED_VALUE,
    subtype: "message" as const,
    entityId: "rmsg-003",
    encryptedValue: encryptedBlob,
  });

  subscriber.next({
    type: EventType.REASONING_END,
    messageId: "reasoning-003",
  });
}
```

### Pattern 4: Passing encrypted values back on subsequent turns

The client must include `encryptedValue` in the messages array on the next request to maintain reasoning continuity:

```typescript
import type { ReasoningMessage, RunAgentInput } from "@ag-ui/core";

// Client stores the encrypted blob from REASONING_ENCRYPTED_VALUE events
const reasoningMsg: ReasoningMessage = {
  id: "rmsg-003",
  role: "reasoning",
  content: "Analyzing your request securely...", // Visible summary
  encryptedValue: storedEncryptedBlob,           // Opaque to client
};

const nextInput: RunAgentInput = {
  threadId: "thread-1",
  runId: "run-2",
  messages: [
    // Previous messages...
    reasoningMsg,
    { id: "user-002", role: "user", content: "Follow up question" },
  ],
  tools: [],
  state: {},
  context: [],
  forwardedProps: {},
};
```

## Common Mistakes

### Mistake 1: Using deprecated THINKING_* events (priority: HIGH)

`THINKING_START`, `THINKING_END`, `THINKING_TEXT_MESSAGE_START`, `THINKING_TEXT_MESSAGE_CONTENT`, and `THINKING_TEXT_MESSAGE_END` are deprecated since v0.0.45. A backward-compatibility middleware auto-converts them, but new code must use `REASONING_*` events. They will be removed in v1.0.0.

Wrong:

```typescript
subscriber.next({ type: EventType.THINKING_START });
subscriber.next({ type: EventType.THINKING_TEXT_MESSAGE_START });
subscriber.next({
  type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
  delta: "thinking...",
});
subscriber.next({ type: EventType.THINKING_TEXT_MESSAGE_END });
subscriber.next({ type: EventType.THINKING_END });
```

Correct:

```typescript
subscriber.next({
  type: EventType.REASONING_START,
  messageId: "reasoning-001",
});
subscriber.next({
  type: EventType.REASONING_MESSAGE_START,
  messageId: "rmsg-001",
  role: "reasoning" as const,
});
subscriber.next({
  type: EventType.REASONING_MESSAGE_CONTENT,
  messageId: "rmsg-001",
  delta: "thinking...",
});
subscriber.next({
  type: EventType.REASONING_MESSAGE_END,
  messageId: "rmsg-001",
});
subscriber.next({
  type: EventType.REASONING_END,
  messageId: "reasoning-001",
});
```

### Mistake 2: Not pairing REASONING_START with REASONING_END (priority: HIGH)

Every `REASONING_START` must have a corresponding `REASONING_END`. Unpaired events leave the reasoning state machine in an invalid state and cause verifier errors.

Wrong:

```typescript
subscriber.next({
  type: EventType.REASONING_START,
  messageId: "reasoning-001",
});
subscriber.next({
  type: EventType.REASONING_MESSAGE_CHUNK,
  messageId: "rmsg-001",
  delta: "Thinking...",
});
// Missing REASONING_END -- verifier will reject this
subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
```

Correct:

```typescript
subscriber.next({
  type: EventType.REASONING_START,
  messageId: "reasoning-001",
});
subscriber.next({
  type: EventType.REASONING_MESSAGE_CHUNK,
  messageId: "rmsg-001",
  delta: "Thinking...",
});
subscriber.next({
  type: EventType.REASONING_END,
  messageId: "reasoning-001",
});
subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
```

### Mistake 3: Discarding encryptedValue on subsequent turns (priority: HIGH)

For ZDR compliance, encrypted reasoning values must be passed back in the messages array on the next request. Discarding them breaks reasoning continuity across turns -- the agent loses its chain-of-thought context.

Wrong:

```typescript
// Client receives REASONING_ENCRYPTED_VALUE but drops it
function handleEvent(event: BaseEvent): void {
  if (event.type === EventType.REASONING_ENCRYPTED_VALUE) {
    // Ignored -- encryptedValue is lost
  }
}

// Next request has no encryptedValue -- reasoning continuity broken
const messages = [
  { id: "rmsg-003", role: "reasoning", content: "Summary only" },
  // encryptedValue missing
];
```

Correct:

```typescript
const encryptedValues = new Map<string, string>();

function handleEvent(event: BaseEvent): void {
  if (event.type === EventType.REASONING_ENCRYPTED_VALUE) {
    const e = event as ReasoningEncryptedValueEvent;
    encryptedValues.set(e.entityId, e.encryptedValue);
  }
}

// Include encryptedValue in the ReasoningMessage on next request
const messages = [
  {
    id: "rmsg-003",
    role: "reasoning" as const,
    content: "Summary only",
    encryptedValue: encryptedValues.get("rmsg-003"),
  },
];
```

See also: `agui-run-lifecycle`, `agui-capability-events` (ReasoningCapabilities)
