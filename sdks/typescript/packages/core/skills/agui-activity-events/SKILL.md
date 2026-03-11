---
name: agui-activity-events
description: >
  Use ACTIVITY_SNAPSHOT and ACTIVITY_DELTA events for frontend-only UI elements:
  loading indicators, progress bars, status updates. ActivityMessage with activityType
  discriminator. Frontend-only -- never forwarded to agent. Replace flag controls update behavior.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/events.ts
  - ag-ui-protocol/ag-ui:docs/concepts/events.mdx
  - ag-ui-protocol/ag-ui:docs/concepts/messages.mdx
requires:
  - agui-run-lifecycle
---

# AG-UI -- Activity Events

## Setup

Minimum imports for activity events:

```typescript
import {
  EventType,
  BaseEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  ActivityMessage,
  RunStartedEvent,
  RunFinishedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
```

Emitting an activity snapshot within a run:

```typescript
function emitActivitySnapshot(
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
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "SEARCH",
      content: {
        query: "AG-UI protocol events",
        status: "in_progress",
        resultsFound: 0,
      },
      replace: true,
    } as ActivitySnapshotEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

The ActivityMessage type stored in conversation history:

```typescript
import { ActivityMessage } from "@ag-ui/core";

const activityMsg: ActivityMessage = {
  id: "activity-1",
  role: "activity",
  activityType: "SEARCH",
  content: {
    query: "AG-UI protocol events",
    status: "complete",
    resultsFound: 12,
  },
};
```

## Core Patterns

### Pattern 1: Live-Updating Activity with Snapshot and Delta

Use ACTIVITY_SNAPSHOT to create an activity, then ACTIVITY_DELTA to
incrementally update it via JSON Patch (RFC 6902). The activityType
field acts as a discriminator for the frontend to select the correct
rendering component.

```typescript
import {
  EventType,
  BaseEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  RunStartedEvent,
  RunFinishedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function searchWithProgress(
  threadId: string,
  runId: string,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

    // Create activity with initial state
    subscriber.next({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "search-1",
      activityType: "SEARCH",
      content: {
        query: "machine learning papers",
        status: "searching",
        sources: [],
        progress: 0,
      },
      replace: true,
    } as ActivitySnapshotEvent);

    // Update progress incrementally with JSON Patch
    subscriber.next({
      type: EventType.ACTIVITY_DELTA,
      messageId: "search-1",
      activityType: "SEARCH",
      patch: [
        { op: "replace", path: "/progress", value: 33 },
        { op: "add", path: "/sources/-", value: "arxiv.org" },
      ],
    } as ActivityDeltaEvent);

    subscriber.next({
      type: EventType.ACTIVITY_DELTA,
      messageId: "search-1",
      activityType: "SEARCH",
      patch: [
        { op: "replace", path: "/progress", value: 66 },
        { op: "add", path: "/sources/-", value: "scholar.google.com" },
      ],
    } as ActivityDeltaEvent);

    subscriber.next({
      type: EventType.ACTIVITY_DELTA,
      messageId: "search-1",
      activityType: "SEARCH",
      patch: [
        { op: "replace", path: "/progress", value: 100 },
        { op: "replace", path: "/status", value: "complete" },
        { op: "add", path: "/sources/-", value: "semanticscholar.org" },
      ],
    } as ActivityDeltaEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

### Pattern 2: Plan/Checklist Activity

Activity events work well for rendering structured UI like checklists
or multi-step plans.

```typescript
import {
  EventType,
  BaseEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
} from "@ag-ui/core";
import { Subscriber } from "rxjs";

function emitPlanActivity(subscriber: Subscriber<BaseEvent>): void {
  // Create a plan with steps
  subscriber.next({
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: "plan-1",
    activityType: "PLAN",
    content: {
      title: "Research Report",
      steps: [
        { name: "Gather sources", status: "pending" },
        { name: "Analyze data", status: "pending" },
        { name: "Write summary", status: "pending" },
      ],
    },
    replace: true,
  } as ActivitySnapshotEvent);

  // Mark step 0 as complete
  subscriber.next({
    type: EventType.ACTIVITY_DELTA,
    messageId: "plan-1",
    activityType: "PLAN",
    patch: [
      { op: "replace", path: "/steps/0/status", value: "complete" },
      { op: "replace", path: "/steps/1/status", value: "in_progress" },
    ],
  } as ActivityDeltaEvent);

  // Mark step 1 as complete, start step 2
  subscriber.next({
    type: EventType.ACTIVITY_DELTA,
    messageId: "plan-1",
    activityType: "PLAN",
    patch: [
      { op: "replace", path: "/steps/1/status", value: "complete" },
      { op: "replace", path: "/steps/2/status", value: "in_progress" },
    ],
  } as ActivityDeltaEvent);
}
```

### Pattern 3: Replace Flag Behavior

The `replace` field on ACTIVITY_SNAPSHOT (defaults to `true`) controls
whether an existing activity message is overwritten.

- `replace: true` (default): Replace the existing activity message
  with the new snapshot.
- `replace: false`: Ignore the snapshot if the message already exists.
  Only create it if new.

```typescript
import {
  EventType,
  ActivitySnapshotEvent,
} from "@ag-ui/core";

// replace: true (default) -- always overwrites
const overwriteSnapshot: ActivitySnapshotEvent = {
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId: "status-1",
  activityType: "STATUS",
  content: { message: "Processing complete", code: 200 },
  replace: true,
};

// replace: false -- only creates if "status-1" doesn't exist yet
const createOnlySnapshot: ActivitySnapshotEvent = {
  type: EventType.ACTIVITY_SNAPSHOT,
  messageId: "status-1",
  activityType: "STATUS",
  content: { message: "Initial status", code: 0 },
  replace: false,
};
```

## Common Mistakes

### 1. Forwarding activity messages to agent (HIGH)

ActivityMessages (role: "activity") are frontend-only and should never be
forwarded to the agent. They are not part of the LLM conversation and
cause confusion if sent. Filter them out before passing messages to
the agent.

```typescript
import { Message } from "@ag-ui/core";

// WRONG: sending all messages including activities to the agent
function getMessagesForAgent_wrong(messages: Message[]): Message[] {
  return messages; // Includes activity messages!
}
```

```typescript
import { Message } from "@ag-ui/core";

// CORRECT: filter out activity messages before sending to agent
function getMessagesForAgent(messages: Message[]): Message[] {
  return messages.filter((msg) => msg.role !== "activity");
}
```

### 2. Ignoring replace flag on ACTIVITY_SNAPSHOT (MEDIUM)

When `replace=true` (default), the new snapshot replaces the prior activity
message. When `replace=false`, the snapshot is ignored if the message
already exists. Not handling this causes duplicate or missing activities.

```typescript
import { ActivitySnapshotEvent } from "@ag-ui/core";

// WRONG: always replacing regardless of the replace flag
function handleActivitySnapshot_wrong(
  event: ActivitySnapshotEvent,
  activities: Map<string, any>,
): void {
  activities.set(event.messageId, event.content); // Ignores replace flag
}
```

```typescript
import { ActivitySnapshotEvent } from "@ag-ui/core";

// CORRECT: respect the replace flag
function handleActivitySnapshot(
  event: ActivitySnapshotEvent,
  activities: Map<string, any>,
): void {
  const exists = activities.has(event.messageId);
  if (!exists || event.replace !== false) {
    activities.set(event.messageId, {
      id: event.messageId,
      role: "activity" as const,
      activityType: event.activityType,
      content: event.content,
    });
  }
}
```

### 3. Activity messages lost across MESSAGES_SNAPSHOT (MEDIUM)

The defaultApplyEvents implementation preserves activity messages during
MESSAGES_SNAPSHOT merges. Custom implementations must also handle this
or activity UI disappears when a snapshot arrives.

```typescript
import { Message } from "@ag-ui/core";

// WRONG: MESSAGES_SNAPSHOT replaces everything including activities
function handleMessagesSnapshot_wrong(
  snapshotMessages: Message[],
): Message[] {
  return snapshotMessages; // Activity messages from prior events are lost
}
```

```typescript
import { Message } from "@ag-ui/core";

// CORRECT: preserve activity messages across snapshots
function handleMessagesSnapshot(
  snapshotMessages: Message[],
  currentMessages: Message[],
): Message[] {
  const activityMessages = currentMessages.filter(
    (msg) => msg.role === "activity",
  );
  return [...snapshotMessages, ...activityMessages];
}
```

See also: agui-run-lifecycle, agui-state-synchronization, agui-custom-and-raw-events
