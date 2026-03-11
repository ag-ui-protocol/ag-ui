---
name: agui-serialization
description: >
  Persist event streams via JSON serialization. Compact verbose histories by collapsing
  TEXT_MESSAGE_* to MESSAGES_SNAPSHOT and STATE_DELTA chains to STATE_SNAPSHOT.
  Branch from any prior run via parentRunId. Normalize input to deduplicate messages.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:docs/concepts/serialization.mdx
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/client/src/apply/default.ts
requires:
  - agui-state-synchronization
---

# AG-UI — Serialization

## Setup

AG-UI events are plain objects with a `type` discriminator. Serialization is
straightforward JSON. The key concepts are: persist the event stream, compact
it for storage efficiency, and use `parentRunId` for branching.

```typescript
import {
  BaseEvent,
  EventType,
  RunStartedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  RunFinishedEvent,
  MessagesSnapshotEvent,
  StateSnapshotEvent,
  Message,
} from "@ag-ui/core";

// Capture events during a run
const events: BaseEvent[] = [];

const agent = new HttpAgent({ url: "https://agent.example.com" });

agent.subscribe({
  onEvent: ({ event }) => {
    events.push(event);
  },
});

await agent.runAgent();

// Serialize to JSON for persistence
const serialized = JSON.stringify(events);
await storage.save(agent.threadId, serialized);
```

## Core Patterns

### Pattern 1: Event compaction

Compaction reduces verbose event streams to equivalent snapshots. This is useful
for long-running conversations where storing every `TEXT_MESSAGE_CONTENT` delta
wastes space.

Compaction rules:
- Merge `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` + `TEXT_MESSAGE_END` sequences into a `MESSAGES_SNAPSHOT`
- Collapse `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` into a compact record within `MESSAGES_SNAPSHOT`
- Merge consecutive `STATE_DELTA` events into a single `STATE_SNAPSHOT` with the final state
- Remove `RUN_STARTED` / `RUN_FINISHED` lifecycle events (they are implicit in the snapshot)
- Preserve `ACTIVITY_SNAPSHOT` and `ACTIVITY_DELTA` events (they represent frontend UI state)

```typescript
import {
  BaseEvent,
  EventType,
  Message,
  MessagesSnapshotEvent,
  StateSnapshotEvent,
} from "@ag-ui/core";
import * as jsonpatch from "fast-json-patch";

function compactEvents(events: BaseEvent[]): BaseEvent[] {
  const messages: Message[] = [];
  let state: Record<string, any> = {};
  let currentMessage: Message | null = null;
  let currentToolArgs = new Map<string, string>();
  const result: BaseEvent[] = [];

  for (const event of events) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START: {
        const e = event as any;
        currentMessage = {
          id: e.messageId,
          role: e.role ?? "assistant",
          content: "",
        };
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const e = event as any;
        if (currentMessage && typeof currentMessage.content === "string") {
          currentMessage.content += e.delta;
        }
        break;
      }
      case EventType.TEXT_MESSAGE_END: {
        if (currentMessage) {
          messages.push(currentMessage);
          currentMessage = null;
        }
        break;
      }
      case EventType.TOOL_CALL_START: {
        const e = event as any;
        currentToolArgs.set(e.toolCallId, "");
        // Attach to current message if one exists, or create assistant message
        if (!currentMessage) {
          currentMessage = {
            id: e.parentMessageId ?? e.toolCallId,
            role: "assistant",
            toolCalls: [],
          };
        }
        (currentMessage as any).toolCalls ??= [];
        (currentMessage as any).toolCalls.push({
          id: e.toolCallId,
          type: "function",
          function: { name: e.toolCallName, arguments: "" },
        });
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const e = event as any;
        const existing = currentToolArgs.get(e.toolCallId) ?? "";
        currentToolArgs.set(e.toolCallId, existing + e.delta);
        // Update the tool call arguments in the message
        if (currentMessage && (currentMessage as any).toolCalls) {
          const tc = (currentMessage as any).toolCalls.find(
            (t: any) => t.id === e.toolCallId
          );
          if (tc) tc.function.arguments = currentToolArgs.get(e.toolCallId)!;
        }
        break;
      }
      case EventType.TOOL_CALL_END: {
        // Tool call is complete -- keep it in the message
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const e = event as any;
        messages.push({
          id: e.messageId,
          role: "tool",
          toolCallId: e.toolCallId,
          content: e.content,
        } as any);
        break;
      }
      case EventType.STATE_SNAPSHOT: {
        state = (event as any).snapshot;
        break;
      }
      case EventType.STATE_DELTA: {
        const e = event as any;
        try {
          const patched = jsonpatch.applyPatch(state, e.delta, true, false);
          state = patched.newDocument;
        } catch {
          // Skip invalid patches
        }
        break;
      }
      case EventType.MESSAGES_SNAPSHOT: {
        messages.length = 0;
        messages.push(...(event as any).messages);
        break;
      }
      // Preserve activity and other events as-is
      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA:
        result.push(event);
        break;
    }
  }

  // Flush any in-progress message
  if (currentMessage) {
    messages.push(currentMessage);
  }

  // Emit compacted snapshots
  if (messages.length > 0) {
    result.unshift({
      type: EventType.MESSAGES_SNAPSHOT,
      messages,
    } as MessagesSnapshotEvent);
  }
  if (Object.keys(state).length > 0) {
    result.push({
      type: EventType.STATE_SNAPSHOT,
      snapshot: state,
    } as StateSnapshotEvent);
  }

  return result;
}
```

### Pattern 2: Branching with parentRunId

Set `parentRunId` on a `RUN_STARTED` event to create a branch from a prior run.
This forms a git-like append-only log where each run can branch from any
previous run in the same thread.

```typescript
import { EventType, RunStartedEvent } from "@ag-ui/core";

// Original run
const run1: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-1",
};

// Linear continuation
const run2: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-2",
  parentRunId: "run-1",
};

// Branch from run-1 (alternative path)
const run3: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-3",
  parentRunId: "run-1",
  // input.messages should only contain NEW messages for this branch
  input: {
    messages: [
      { id: "msg-new", role: "user", content: "Try a different approach" },
    ],
  },
};
```

To reconstruct conversation state at any branch point, replay events from the
root through the chain of `parentRunId` references.

### Pattern 3: Input normalization on branched runs

When branching with `parentRunId`, the new run's `input.messages` may include
messages already present in the event history. Normalization removes duplicates
so messages do not appear twice when replaying.

```typescript
import { BaseEvent, EventType, Message, RunStartedEvent } from "@ag-ui/core";

function normalizeRunInput(
  existingEvents: BaseEvent[],
  newRunInput: RunStartedEvent
): RunStartedEvent {
  // Collect all message IDs from prior events
  const knownMessageIds = new Set<string>();
  for (const event of existingEvents) {
    if (event.type === EventType.MESSAGES_SNAPSHOT) {
      for (const msg of (event as any).messages) {
        knownMessageIds.add(msg.id);
      }
    }
    if (event.type === EventType.TEXT_MESSAGE_START) {
      knownMessageIds.add((event as any).messageId);
    }
  }

  // Remove messages that already exist in history
  if (newRunInput.input?.messages) {
    const deduplicated = newRunInput.input.messages.filter(
      (m: Message) => !knownMessageIds.has(m.id)
    );
    return {
      ...newRunInput,
      input: {
        ...newRunInput.input,
        messages: deduplicated,
      },
    };
  }

  return newRunInput;
}
```

### Pattern 4: Restoring a conversation from serialized events

Replay serialized events through `defaultApplyEvents` to reconstruct messages
and state, or use compacted snapshots directly.

```typescript
import { BaseEvent, EventType, Message } from "@ag-ui/core";

// Load from storage
const serialized = await storage.load("thread-1");
const events: BaseEvent[] = JSON.parse(serialized);

// Option 1: Compact and use snapshots directly
const compacted = compactEvents(events);
let messages: Message[] = [];
let state: Record<string, any> = {};

for (const event of compacted) {
  if (event.type === EventType.MESSAGES_SNAPSHOT) {
    messages = (event as any).messages;
  }
  if (event.type === EventType.STATE_SNAPSHOT) {
    state = (event as any).snapshot;
  }
}

// Option 2: Initialize a new agent with restored state
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({
  url: "https://agent.example.com",
  threadId: "thread-1",
  initialMessages: messages,
  initialState: state,
});

// Continue the conversation
await agent.runAgent();
```

## Common Mistakes

### 1. Compacting before run completion (MEDIUM)

Compaction merges `TEXT_MESSAGE_*` sequences into snapshots and collapses
`STATE_DELTA` chains. Running it on an incomplete run (before `RUN_FINISHED`)
loses in-progress message fragments and produces an incorrect snapshot.

Wrong:

```typescript
agent.subscribe({
  onEvent: ({ event }) => {
    events.push(event);
    // Compacting on every event -- incomplete messages get merged incorrectly
    const compacted = compactEvents(events);
    await storage.save(threadId, JSON.stringify(compacted));
  },
});
```

Correct:

```typescript
agent.subscribe({
  onEvent: ({ event }) => {
    events.push(event);
  },
  onRunFinishedEvent: () => {
    // Compact only after the run is complete
    const compacted = compactEvents(events);
    storage.save(threadId, JSON.stringify(compacted));
  },
});
```

### 2. Losing activity messages during compaction (MEDIUM)

Activity messages (`role: "activity"`) represent frontend UI state (loading
indicators, progress bars). They must be preserved during compaction because
they are not part of the LLM conversation but are needed for UI restoration.
Custom compaction logic must handle them separately from regular messages.

Wrong:

```typescript
// Naive compaction that only emits MESSAGES_SNAPSHOT
function naiveCompact(events: BaseEvent[]): BaseEvent[] {
  const messages = rebuildMessages(events);
  return [{ type: EventType.MESSAGES_SNAPSHOT, messages }];
  // Activity messages are lost
}
```

Correct:

```typescript
function compactWithActivities(events: BaseEvent[]): BaseEvent[] {
  const messages = rebuildMessages(events);
  const result: BaseEvent[] = [
    { type: EventType.MESSAGES_SNAPSHOT, messages } as any,
  ];

  // Preserve activity events as-is
  for (const event of events) {
    if (
      event.type === EventType.ACTIVITY_SNAPSHOT ||
      event.type === EventType.ACTIVITY_DELTA
    ) {
      result.push(event);
    }
  }

  return result;
}
```

### 3. Not normalizing input on branched runs (MEDIUM)

When branching with `parentRunId`, the new run's input may include messages
that already exist in the serialized history. Without normalization, messages
appear twice when replaying the event log -- once from the original history
and once from the new run's input.

Wrong:

```typescript
// Branch from run-1, but include all messages including ones already in history
const branchRun: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-3",
  parentRunId: "run-1",
  input: {
    // msg-1 already exists in history from run-1
    messages: [
      { id: "msg-1", role: "user", content: "Hello" },
      { id: "msg-3", role: "user", content: "New message" },
    ],
  },
};
// Replaying events will show msg-1 twice
```

Correct:

```typescript
// Only include new messages not already in history
const branchRun: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-3",
  parentRunId: "run-1",
  input: {
    // Only the new message -- msg-1 is already in history
    messages: [
      { id: "msg-3", role: "user", content: "New message" },
    ],
  },
};
```

See also: `agui-state-synchronization`, `agui-run-lifecycle`
