---
name: agui-run-lifecycle
description: >
  Manage the agent run lifecycle with RUN_STARTED, RUN_FINISHED, RUN_ERROR events.
  Track steps with STEP_STARTED/STEP_FINISHED. Handle multiple sequential runs
  in one stream with parentRunId lineage. Strict event ordering enforced by verifier.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/events.ts
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/client/src/verify/verify.ts
  - ag-ui-protocol/ag-ui:docs/concepts/events.mdx
---

# AG-UI -- Run Lifecycle

## Setup

Minimum imports for emitting run lifecycle events:

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
```

Minimal run that starts and finishes:

```typescript
function minimalRun(threadId: string, runId: string): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

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

### Pattern 1: Run with Steps

Steps provide granular visibility into agent processing stages. Every
STEP_STARTED must have a matching STEP_FINISHED before RUN_FINISHED.

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function runWithSteps(threadId: string, runId: string): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

    subscriber.next({
      type: EventType.STEP_STARTED,
      stepName: "retrieve_context",
    } as StepStartedEvent);

    // ... do retrieval work, emit other events ...

    subscriber.next({
      type: EventType.STEP_FINISHED,
      stepName: "retrieve_context",
    } as StepFinishedEvent);

    subscriber.next({
      type: EventType.STEP_STARTED,
      stepName: "generate_response",
    } as StepStartedEvent);

    // ... do generation work, emit other events ...

    subscriber.next({
      type: EventType.STEP_FINISHED,
      stepName: "generate_response",
    } as StepFinishedEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

### Pattern 2: Error Handling with RUN_ERROR

RUN_ERROR terminates the run. No events are allowed after it.

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunErrorEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function runWithErrorHandling(
  threadId: string,
  runId: string,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

    const execute = async () => {
      try {
        // ... agent work that may fail ...
        throw new Error("LLM provider timeout");
      } catch (error) {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : String(error),
          code: "PROVIDER_TIMEOUT",
        } as RunErrorEvent);
        subscriber.complete();
      }
    };

    execute();
  });
}
```

### Pattern 3: Multiple Sequential Runs

A single Observable stream can contain multiple sequential runs.
Each run must finish before the next starts. State evolves across runs;
messages accumulate (they do NOT reset between runs).

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function sequentialRuns(threadId: string): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    // --- Run 1 ---
    const runId1 = "run-1";
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId: runId1,
    } as RunStartedEvent);

    subscriber.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    } as TextMessageStartEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "First run response",
    } as TextMessageContentEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId: runId1,
    } as RunFinishedEvent);

    // --- Run 2 (references run 1 via parentRunId) ---
    const runId2 = "run-2";
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId: runId2,
      parentRunId: runId1,
    } as RunStartedEvent);

    subscriber.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-2",
      role: "assistant",
    } as TextMessageStartEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-2",
      delta: "Second run response",
    } as TextMessageContentEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-2",
    } as TextMessageEndEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId: runId2,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

### Pattern 4: parentRunId for Branching

Use parentRunId to create a lineage chain across runs, enabling
time-travel and branching from any prior run.

```typescript
import {
  EventType,
  RunStartedEvent,
} from "@ag-ui/core";

// First run has no parent
const firstRun: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-1",
};

// Second run chains from first
const secondRun: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-2",
  parentRunId: "run-1",
};

// Branch: new run forks from the first run (not the second)
const branchRun: RunStartedEvent = {
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-3",
  parentRunId: "run-1",
};
```

## Common Mistakes

### 1. Events after RUN_ERROR (CRITICAL)

No events are permitted after RUN_ERROR. The verifier throws
"The run has already errored with RUN_ERROR. No further events can be sent."

```typescript
// WRONG: emitting events after RUN_ERROR
subscriber.next({
  type: EventType.RUN_ERROR,
  message: "Something failed",
} as RunErrorEvent);
subscriber.next({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
} as RunFinishedEvent); // Throws!
```

```typescript
// CORRECT: RUN_ERROR is the terminal event, then complete
subscriber.next({
  type: EventType.RUN_ERROR,
  message: "Something failed",
} as RunErrorEvent);
subscriber.complete();
```

### 2. Non-RUN_STARTED events after RUN_FINISHED (HIGH)

After RUN_FINISHED, the only valid next event is RUN_STARTED (to begin
a new sequential run). Any other event throws "The run has already finished."

```typescript
// WRONG: sending content after run finished
subscriber.next({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
} as RunFinishedEvent);
subscriber.next({
  type: EventType.TEXT_MESSAGE_START,
  messageId: "late-msg",
  role: "assistant",
} as TextMessageStartEvent); // Throws!
```

```typescript
// CORRECT: start a new run if more work is needed
subscriber.next({
  type: EventType.RUN_FINISHED,
  threadId,
  runId: "run-1",
} as RunFinishedEvent);
subscriber.next({
  type: EventType.RUN_STARTED,
  threadId,
  runId: "run-2",
  parentRunId: "run-1",
} as RunStartedEvent);
// Now emit events within run-2
```

### 3. Unbalanced STEP_STARTED/STEP_FINISHED (MEDIUM)

STEP_FINISHED with a stepName that was not started throws a verification
error. RUN_FINISHED with active steps lists the unfinished step names.

```typescript
// WRONG: finishing a step that was never started
subscriber.next({
  type: EventType.STEP_FINISHED,
  stepName: "nonexistent",
} as StepFinishedEvent); // Throws!
```

```typescript
// WRONG: RUN_FINISHED with unclosed step
subscriber.next({
  type: EventType.STEP_STARTED,
  stepName: "analyze",
} as StepStartedEvent);
subscriber.next({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
} as RunFinishedEvent); // Throws: step "analyze" still active
```

```typescript
// CORRECT: always pair steps
subscriber.next({
  type: EventType.STEP_STARTED,
  stepName: "analyze",
} as StepStartedEvent);
// ... work ...
subscriber.next({
  type: EventType.STEP_FINISHED,
  stepName: "analyze",
} as StepFinishedEvent);
subscriber.next({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
} as RunFinishedEvent);
```

### 4. Starting new run without finishing current one (HIGH)

RUN_STARTED while a run is already active throws "Cannot send
RUN_STARTED while a run is still active."

```typescript
// WRONG: starting a second run without finishing the first
subscriber.next({
  type: EventType.RUN_STARTED,
  threadId,
  runId: "run-1",
} as RunStartedEvent);
subscriber.next({
  type: EventType.RUN_STARTED,
  threadId,
  runId: "run-2",
} as RunStartedEvent); // Throws!
```

```typescript
// CORRECT: finish the first run before starting the next
subscriber.next({
  type: EventType.RUN_STARTED,
  threadId,
  runId: "run-1",
} as RunStartedEvent);
subscriber.next({
  type: EventType.RUN_FINISHED,
  threadId,
  runId: "run-1",
} as RunFinishedEvent);
subscriber.next({
  type: EventType.RUN_STARTED,
  threadId,
  runId: "run-2",
  parentRunId: "run-1",
} as RunStartedEvent);
```

### 5. Assuming messages reset each run (HIGH, cross-skill)

Messages accumulate across sequential runs in the same thread.
Only a MESSAGES_SNAPSHOT resets them. New run messages are appended
to existing history.

```typescript
// WRONG: assuming run-2 starts with empty message history
// After run-1 produced messages ["msg-1"], run-2's context
// already includes "msg-1". Do not duplicate it.

// CORRECT: messages from run-1 persist into run-2.
// If a reset is needed, emit MESSAGES_SNAPSHOT with the desired array.
subscriber.next({
  type: EventType.MESSAGES_SNAPSHOT,
  messages: [], // explicitly clears history
} as any);
```

See also: agui-text-message-events, agui-tool-calling-events, agui-state-synchronization
