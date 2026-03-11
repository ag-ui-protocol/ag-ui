---
name: agui-custom-and-raw-events
description: >
  Handle RAW events from external systems (arbitrary structure, source attribution)
  and CUSTOM application-defined events (name + value). Use only for truly app-specific
  needs -- standard event types for interoperable features.
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/core/src/events.ts
  - ag-ui-protocol/ag-ui:docs/concepts/events.mdx
requires:
  - agui-run-lifecycle
---

# AG-UI -- Custom and Raw Events

## Setup

Minimum imports for custom and raw events:

```typescript
import {
  EventType,
  BaseEvent,
  CustomEvent,
  RawEvent,
  RunStartedEvent,
  RunFinishedEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";
```

Emitting a custom event within a run:

```typescript
function emitCustomEvent(
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
      type: EventType.CUSTOM,
      name: "user_feedback_requested",
      value: { question: "Was this helpful?", options: ["yes", "no"] },
    } as CustomEvent);

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

### Pattern 1: CUSTOM Events for Application-Specific Needs

CUSTOM events carry a `name` (string) and `value` (any). Use them for
features not covered by standard event types. The `name` acts as a
discriminator for consumers to route the event.

```typescript
import {
  EventType,
  BaseEvent,
  CustomEvent,
} from "@ag-ui/core";
import { Subscriber } from "rxjs";

// Emit a progress notification
function emitProgress(
  subscriber: Subscriber<BaseEvent>,
  percentage: number,
  label: string,
): void {
  subscriber.next({
    type: EventType.CUSTOM,
    name: "progress_update",
    value: { percentage, label },
  } as CustomEvent);
}

// Emit a citation reference
function emitCitation(
  subscriber: Subscriber<BaseEvent>,
  sourceUrl: string,
  title: string,
  snippet: string,
): void {
  subscriber.next({
    type: EventType.CUSTOM,
    name: "citation",
    value: { sourceUrl, title, snippet },
  } as CustomEvent);
}

// Handle custom events on the consumer side
function handleCustomEvent(event: CustomEvent): void {
  switch (event.name) {
    case "progress_update":
      updateProgressBar(event.value.percentage, event.value.label);
      break;
    case "citation":
      renderCitation(event.value.sourceUrl, event.value.title);
      break;
    default:
      console.warn(`Unknown custom event: ${event.name}`);
  }
}

// Placeholder functions for illustration
function updateProgressBar(pct: number, label: string): void {}
function renderCitation(url: string, title: string): void {}
```

### Pattern 2: RAW Events for External System Passthrough

RAW events wrap events from external systems with no guaranteed
structure. The optional `source` field identifies the originating system.
Consumers must handle arbitrary shapes.

```typescript
import {
  EventType,
  BaseEvent,
  RawEvent,
} from "@ag-ui/core";
import { Subscriber } from "rxjs";

// Wrap a LangGraph event as RAW
function emitLangGraphEvent(
  subscriber: Subscriber<BaseEvent>,
  langGraphEvent: Record<string, unknown>,
): void {
  subscriber.next({
    type: EventType.RAW,
    event: langGraphEvent,
    source: "langgraph",
  } as RawEvent);
}

// Wrap a third-party webhook payload as RAW
function emitWebhookEvent(
  subscriber: Subscriber<BaseEvent>,
  webhookPayload: unknown,
  webhookSource: string,
): void {
  subscriber.next({
    type: EventType.RAW,
    event: webhookPayload,
    source: webhookSource,
  } as RawEvent);
}

// Handle raw events by checking source
function handleRawEvent(event: RawEvent): void {
  switch (event.source) {
    case "langgraph":
      processLangGraphEvent(event.event);
      break;
    case "slack-webhook":
      processSlackEvent(event.event);
      break;
    default:
      console.log("Raw event from unknown source:", event.source);
  }
}

// Placeholder functions for illustration
function processLangGraphEvent(data: unknown): void {}
function processSlackEvent(data: unknown): void {}
```

### Pattern 3: CUSTOM Events Combined with Standard Events

Custom events interleave freely with standard protocol events within
a run. They do not affect the verifier state machine.

```typescript
import {
  EventType,
  BaseEvent,
  RunStartedEvent,
  RunFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  CustomEvent,
} from "@ag-ui/core";
import { Observable } from "rxjs";

function runWithCustomEvents(
  threadId: string,
  runId: string,
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    subscriber.next({
      type: EventType.RUN_STARTED,
      threadId,
      runId,
    } as RunStartedEvent);

    // Custom event: signal that retrieval is starting
    subscriber.next({
      type: EventType.CUSTOM,
      name: "retrieval_started",
      value: { query: "AG-UI protocol", sources: 3 },
    } as CustomEvent);

    // Standard text message
    subscriber.next({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    } as TextMessageStartEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "Based on the retrieved documents...",
    } as TextMessageContentEvent);
    subscriber.next({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as TextMessageEndEvent);

    // Custom event: attach citations after the message
    subscriber.next({
      type: EventType.CUSTOM,
      name: "citations",
      value: [
        { url: "https://docs.example.com/page1", title: "AG-UI Overview" },
        { url: "https://docs.example.com/page2", title: "Events Reference" },
      ],
    } as CustomEvent);

    subscriber.next({
      type: EventType.RUN_FINISHED,
      threadId,
      runId,
    } as RunFinishedEvent);

    subscriber.complete();
  });
}
```

## Common Mistakes

### 1. Using CUSTOM events for standard protocol features (MEDIUM)

Custom events should only be used for truly application-specific needs.
Using them instead of standard event types (text messages, tool calls,
state) breaks interoperability with other AG-UI consumers.

```typescript
// WRONG: using CUSTOM for text streaming
subscriber.next({
  type: EventType.CUSTOM,
  name: "text_chunk",
  value: { text: "Hello world" },
} as CustomEvent);
```

```typescript
// CORRECT: use the standard TEXT_MESSAGE events
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

### 2. Assuming RAW event structure (MEDIUM)

RAW events wrap external system events with no guaranteed structure.
Consumers must handle arbitrary shapes and should check the `source`
field for attribution before attempting to parse the `event` field.

```typescript
// WRONG: accessing RAW event fields without guards
function handleRaw(event: RawEvent): void {
  const status = event.event.status; // May not exist
  const items = event.event.results.items; // May throw
}
```

```typescript
// CORRECT: check source and validate structure
function handleRaw(event: RawEvent): void {
  if (event.source === "my-service" && typeof event.event === "object") {
    const payload = event.event as Record<string, unknown>;
    if ("status" in payload && typeof payload.status === "string") {
      processStatus(payload.status);
    }
  }
}

function processStatus(status: string): void {}
```

### 3. Missing name field on CUSTOM event (MEDIUM)

CustomEvent requires both `name` (string) and `value` (any). Omitting
the `name` makes the event unroutable by consumers. The Zod schema
enforces `name` as a required string field.

```typescript
// WRONG: omitting name
subscriber.next({
  type: EventType.CUSTOM,
  value: { data: 123 },
} as any); // Schema validation fails: name is required
```

```typescript
// CORRECT: always provide name
subscriber.next({
  type: EventType.CUSTOM,
  name: "metric_update",
  value: { data: 123 },
} as CustomEvent);
```

See also: agui-run-lifecycle, agui-generative-ui, agui-activity-events
