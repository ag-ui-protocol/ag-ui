---
name: agui-generative-ui
description: >
  Integrate generative UI specifications (A2UI, Open-JSON-UI, MCP-UI/MCP Apps) with
  AG-UI as the bidirectional transport layer. AG-UI carries UI payloads but does not
  define the UI format itself. Use CUSTOM events for custom UI components.
type: composition
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:docs/concepts/generative-ui-specs.mdx
requires:
  - agui-custom-and-raw-events
---

# AG-UI — Generative UI

Depends on `agui-custom-and-raw-events`. AG-UI is a **user interaction protocol** (transport), not a generative UI specification. It provides the bidirectional runtime connection between agent and application. Generative UI specs like A2UI, Open-JSON-UI, and MCP-UI define the UI format; AG-UI carries those payloads.

## Setup

```typescript
import {
  EventType,
  type CustomEvent,
  type BaseEvent,
} from "@ag-ui/core";
```

## Core Patterns

### Pattern 1: Understanding the spec landscape

AG-UI natively supports all major generative UI specs as transport payloads:

| Specification   | Origin / Maintainer    | Format         | Approach                                                   |
|-----------------|------------------------|----------------|------------------------------------------------------------|
| **A2UI**        | Google                 | JSONL-based    | Declarative, LLM-friendly, streaming, platform-agnostic    |
| **Open-JSON-UI**| OpenAI                 | JSON Schema    | Standardization of OpenAI's internal declarative UI schema  |
| **MCP-UI / MCP Apps** | Microsoft + Shopify | iframe-based | Extends MCP for user-facing experiences                    |

AG-UI's role is transport -- it does not define which spec to use. The choice depends on the application's rendering framework and requirements.

### Pattern 2: Transporting generative UI payloads via CUSTOM events

Use `CUSTOM` events to carry generative UI payloads through the AG-UI event stream. The `name` field identifies the spec/component type, and `value` carries the payload.

A2UI payload example:

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitA2UIComponent(
  subscriber: { next: (event: BaseEvent) => void },
): void {
  subscriber.next({
    type: EventType.CUSTOM,
    name: "a2ui:component",
    value: {
      type: "card",
      title: "Flight Options",
      content: [
        {
          type: "list",
          items: [
            { text: "AA 123 - $450", action: { type: "select", id: "aa123" } },
            { text: "UA 456 - $380", action: { type: "select", id: "ua456" } },
          ],
        },
      ],
    },
  });
}
```

MCP-UI payload example:

```typescript
function emitMCPUIComponent(
  subscriber: { next: (event: BaseEvent) => void },
): void {
  subscriber.next({
    type: EventType.CUSTOM,
    name: "mcp-ui:app",
    value: {
      appId: "weather-widget",
      iframeSrc: "https://widgets.example.com/weather?city=london",
      width: 400,
      height: 300,
    },
  });
}
```

Open-JSON-UI payload example:

```typescript
function emitOpenJSONUIComponent(
  subscriber: { next: (event: BaseEvent) => void },
): void {
  subscriber.next({
    type: EventType.CUSTOM,
    name: "open-json-ui:form",
    value: {
      schema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email", title: "Email Address" },
          subscribe: { type: "boolean", title: "Subscribe to newsletter" },
        },
        required: ["email"],
      },
      submitAction: "subscribeUser",
    },
  });
}
```

### Pattern 3: Client-side routing of generative UI events

The client filters `CUSTOM` events by name prefix to dispatch to the appropriate renderer:

```typescript
import { EventType, type BaseEvent, type CustomEvent } from "@ag-ui/core";

function handleEvent(event: BaseEvent): void {
  if (event.type !== EventType.CUSTOM) return;

  const customEvent = event as CustomEvent;

  if (customEvent.name.startsWith("a2ui:")) {
    renderA2UIComponent(customEvent.value);
  } else if (customEvent.name.startsWith("mcp-ui:")) {
    renderMCPUIApp(customEvent.value);
  } else if (customEvent.name.startsWith("open-json-ui:")) {
    renderOpenJSONUI(customEvent.value);
  } else {
    // Application-specific custom UI
    renderCustomComponent(customEvent.name, customEvent.value);
  }
}
```

### Pattern 4: Custom application-specific generative UI

For UI components that don't fit any standard spec, define your own CUSTOM event conventions:

```typescript
import { EventType, type BaseEvent } from "@ag-ui/core";

function emitCustomChart(
  subscriber: { next: (event: BaseEvent) => void },
): void {
  subscriber.next({
    type: EventType.CUSTOM,
    name: "app:chart",
    value: {
      chartType: "line",
      title: "Revenue Trend",
      data: [
        { month: "Jan", revenue: 45000 },
        { month: "Feb", revenue: 52000 },
        { month: "Mar", revenue: 61000 },
      ],
      xAxis: "month",
      yAxis: "revenue",
    },
  });
}
```

## Common Mistakes

### Mistake 1: Confusing AG-UI with a generative UI spec (priority: HIGH)

AG-UI is a user interaction protocol (transport), not a generative UI specification. It carries UI payloads from specs like A2UI, Open-JSON-UI, or MCP-UI but does not define the UI format itself.

Wrong:

```typescript
// Treating AG-UI events as UI component definitions
subscriber.next({
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg-1",
  // Trying to embed UI rendering instructions in a text message
});
subscriber.next({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-1",
  delta: "<Button onClick='approve'>Approve</Button>", // AG-UI doesn't define UI
});
```

Correct:

```typescript
// Use CUSTOM events to transport generative UI payloads
subscriber.next({
  type: EventType.CUSTOM,
  name: "a2ui:component",
  value: {
    type: "button",
    label: "Approve",
    action: { type: "callback", id: "approve-action" },
  },
});
```

### Mistake 2: Large UI descriptions reducing agent performance (priority: MEDIUM)

Injecting large generative UI schema descriptions into agent context consumes context window and degrades agent reasoning quality. Keep UI schemas out of the LLM prompt where possible.

Wrong:

```typescript
// Dumping entire UI schema library into the agent's context
const input: RunAgentInput = {
  threadId: "t-1",
  runId: "r-1",
  messages: [],
  tools: [],
  state: {},
  context: [
    {
      description: "Available UI components",
      value: JSON.stringify(entireA2UISchemaLibrary), // Thousands of tokens
    },
  ],
  forwardedProps: {},
};
```

Correct:

```typescript
// Pass only the minimal schema needed for the current task
const input: RunAgentInput = {
  threadId: "t-1",
  runId: "r-1",
  messages: [],
  tools: [],
  state: {},
  context: [
    {
      description: "Available chart types",
      value: JSON.stringify(["line", "bar", "pie"]), // Minimal context
    },
  ],
  forwardedProps: {},
};
```

### Mistake 3: Using tool calls for complex generative UI instead of proper specs (priority: MEDIUM)

While tool calls can trigger UI, dedicated generative UI specs (A2UI, MCP-UI, Open-JSON-UI) provide structured, streaming-friendly UI definitions. Overloading tool calls for complex UI is fragile and not interoperable.

Wrong:

```typescript
// Using a tool call to define complex UI
subscriber.next({
  type: EventType.TOOL_CALL_START,
  toolCallId: "tc-1",
  toolCallName: "renderDashboard",
});
subscriber.next({
  type: EventType.TOOL_CALL_ARGS,
  toolCallId: "tc-1",
  delta: JSON.stringify({
    layout: "grid",
    widgets: [
      { type: "chart", data: largeDataset },
      { type: "table", columns: ["a", "b", "c"], rows: hundredsOfRows },
    ],
  }),
});
subscriber.next({ type: EventType.TOOL_CALL_END, toolCallId: "tc-1" });
```

Correct:

```typescript
// Use CUSTOM events with a proper generative UI spec
subscriber.next({
  type: EventType.CUSTOM,
  name: "a2ui:component",
  value: {
    type: "dashboard",
    layout: "grid",
    widgets: [
      { type: "chart", dataRef: "chart-data-1" },
      { type: "table", dataRef: "table-data-1" },
    ],
  },
});

// Tool calls remain for simple interactions (approval, selection, etc.)
```

See also: `agui-custom-and-raw-events`, `agui-tool-calling-events`
