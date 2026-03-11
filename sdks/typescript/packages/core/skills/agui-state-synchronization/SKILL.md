---
name: agui-state-synchronization
description: >
  Synchronize state with STATE_SNAPSHOT (complete replace) and STATE_DELTA (JSON Patch
  RFC 6902 incremental updates). Manage MESSAGES_SNAPSHOT for conversation history.
  State is a flexible metadata channel for config, IDs, and internal data.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/events.ts
  - ag-ui-protocol/ag-ui:docs/concepts/state.mdx
requires:
  - agui-run-lifecycle
---

# AG-UI — State Synchronization

Depends on `agui-run-lifecycle`. State synchronization uses three event types: `STATE_SNAPSHOT` for full replacement, `STATE_DELTA` for incremental JSON Patch (RFC 6902) updates, and `MESSAGES_SNAPSHOT` for conversation history. State is a flexible metadata channel -- it can carry application config, internal system IDs, proposals, or any structured data between agent and frontend.

## Setup

```typescript
import {
  EventType,
  type StateSnapshotEvent,
  type StateDeltaEvent,
  type MessagesSnapshotEvent,
  type BaseEvent,
  type Message,
} from "@ag-ui/core";
```

For applying JSON Patch operations on the client:

```typescript
import { applyPatch } from "fast-json-patch";
```

## Core Patterns

### Pattern 1: Emitting STATE_SNAPSHOT from an agent

`STATE_SNAPSHOT` delivers a complete state object. The frontend must replace its entire state model -- not merge.

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitStateSnapshot(
  subscriber: { next: (event: BaseEvent) => void },
  threadId: string,
  runId: string,
): void {
  subscriber.next({ type: EventType.RUN_STARTED, threadId, runId });

  subscriber.next({
    type: EventType.STATE_SNAPSHOT,
    snapshot: {
      documentTitle: "Q3 Report",
      sections: ["intro", "analysis", "conclusion"],
      editMode: true,
      metadata: { createdBy: "agent-v2", sessionId: "sess-abc" },
    },
  });

  subscriber.next({ type: EventType.RUN_FINISHED, threadId, runId });
}
```

### Pattern 2: Emitting STATE_DELTA with JSON Patch operations

`STATE_DELTA` sends an array of JSON Patch operations (RFC 6902). Paths use JSON Pointer format (RFC 6901) with leading slash.

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitStateDelta(
  subscriber: { next: (event: BaseEvent) => void },
): void {
  // Replace a single field
  subscriber.next({
    type: EventType.STATE_DELTA,
    delta: [
      { op: "replace", path: "/documentTitle", value: "Q3 Report - Final" },
    ],
  });

  // Add a new field and update an array element
  subscriber.next({
    type: EventType.STATE_DELTA,
    delta: [
      { op: "add", path: "/reviewStatus", value: "in-review" },
      { op: "replace", path: "/sections/1", value: "detailed-analysis" },
    ],
  });

  // Remove a field
  subscriber.next({
    type: EventType.STATE_DELTA,
    delta: [
      { op: "remove", path: "/metadata/sessionId" },
    ],
  });
}
```

### Pattern 3: Applying state events on the client

```typescript
import { EventType, type BaseEvent, type StateSnapshotEvent, type StateDeltaEvent } from "@ag-ui/core";
import { applyPatch } from "fast-json-patch";

let state: Record<string, unknown> = {};

function handleStateEvent(event: BaseEvent): void {
  switch (event.type) {
    case EventType.STATE_SNAPSHOT: {
      const e = event as StateSnapshotEvent;
      state = e.snapshot; // Replace entirely -- do NOT merge
      break;
    }
    case EventType.STATE_DELTA: {
      const e = event as StateDeltaEvent;
      try {
        const result = applyPatch(state, e.delta, true, false);
        state = result.newDocument;
      } catch (error) {
        console.warn("Failed to apply state patch, requesting snapshot");
        // Request a fresh snapshot from the agent
      }
      break;
    }
  }
}
```

### Pattern 4: MESSAGES_SNAPSHOT for conversation history

`MESSAGES_SNAPSHOT` delivers the full conversation history. Messages accumulate across sequential runs -- they do not reset when a new run starts.

```typescript
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";

function emitMessagesSnapshot(
  subscriber: { next: (event: BaseEvent) => void },
  messages: Message[],
): void {
  subscriber.next({
    type: EventType.MESSAGES_SNAPSHOT,
    messages,
  });
}

// Client-side handling:
let conversationHistory: Message[] = [];

function handleMessagesSnapshot(event: BaseEvent): void {
  if (event.type === EventType.MESSAGES_SNAPSHOT) {
    const e = event as MessagesSnapshotEvent;
    conversationHistory = e.messages; // Full replacement
  }
}
```

## Common Mistakes

### Mistake 1: Merging STATE_SNAPSHOT instead of replacing (priority: CRITICAL)

When a `STATE_SNAPSHOT` arrives, the frontend must replace its entire state model. Merging causes stale fields to persist.

Wrong:

```typescript
case EventType.STATE_SNAPSHOT: {
  const e = event as StateSnapshotEvent;
  state = { ...state, ...e.snapshot }; // Wrong: merge keeps stale fields
  break;
}
```

Correct:

```typescript
case EventType.STATE_SNAPSHOT: {
  const e = event as StateSnapshotEvent;
  state = e.snapshot; // Correct: full replacement
  break;
}
```

### Mistake 2: Applying STATE_DELTA to wrong base state (priority: HIGH)

JSON Patch operations are position-dependent. Applying deltas out of order or to the wrong base state produces corrupted state. Always apply in sequence after the latest snapshot.

Wrong:

```typescript
// Storing deltas and applying them later in arbitrary order
const pendingDeltas: StateDeltaEvent[] = [];
// ... later, applying in wrong order
pendingDeltas.forEach((d) => {
  state = applyPatch(state, d.delta, true, false).newDocument;
});
```

Correct:

```typescript
// Apply each delta immediately in arrival order
function handleStateDelta(event: StateDeltaEvent): void {
  try {
    const result = applyPatch(state, event.delta, true, false);
    state = result.newDocument;
  } catch (error) {
    console.warn("Patch failed -- state may be out of sync, request snapshot");
  }
}
```

### Mistake 3: Invalid JSON Pointer path in delta (priority: HIGH)

Patch operations use RFC 6901 JSON Pointer paths. Paths must start with `/` and use `/` as separator. Dot notation or missing leading slash fails silently or throws.

Wrong:

```typescript
subscriber.next({
  type: EventType.STATE_DELTA,
  delta: [
    { op: "replace", path: "user.preferences.theme", value: "dark" },
  ],
});
```

Correct:

```typescript
subscriber.next({
  type: EventType.STATE_DELTA,
  delta: [
    { op: "replace", path: "/user/preferences/theme", value: "dark" },
  ],
});
```

Array indices use numeric segments: `/items/0/name`, not `/items[0]/name`.

### Mistake 4: Assuming messages reset each run (priority: HIGH)

Messages accumulate across sequential runs in the same thread. Only a `MESSAGES_SNAPSHOT` resets them. New run messages are appended to existing history.

Wrong:

```typescript
// Clearing messages when a new run starts
function handleEvent(event: BaseEvent): void {
  if (event.type === EventType.RUN_STARTED) {
    conversationHistory = []; // Wrong: messages persist across runs
  }
}
```

Correct:

```typescript
// Messages persist across runs; only MESSAGES_SNAPSHOT replaces them
function handleEvent(event: BaseEvent): void {
  if (event.type === EventType.MESSAGES_SNAPSHOT) {
    const e = event as MessagesSnapshotEvent;
    conversationHistory = e.messages; // This is the only reset mechanism
  }
  // RUN_STARTED does NOT reset messages
}
```

## References

- [references/json-patch-operations.md](references/json-patch-operations.md) -- All 6 JSON Patch operations with examples

See also: `agui-run-lifecycle` (message accumulation across runs), `agui-capability-events` (StateCapabilities)
