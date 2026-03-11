---
name: agui-middleware
description: >
  Create middleware to transform, filter, and augment event streams. Function-based
  MiddlewareFunction or class-based Middleware with runNext()/runNextWithState() helpers.
  Built-in FilterToolCallsMiddleware. Middleware runs in runAgent() only, not connectAgent().
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/client/src/middleware/middleware.ts
  - ag-ui-protocol/ag-ui:docs/concepts/middleware.mdx
requires:
  - agui-implement-abstract-agent
---

# AG-UI — Middleware

## Setup

Add middleware to any `AbstractAgent` subclass with `agent.use()`:

```typescript
import { HttpAgent, MiddlewareFunction } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { tap } from "rxjs/operators";

const loggingMiddleware: MiddlewareFunction = (input, next) => {
  return next.run(input).pipe(
    tap((event) => console.log(`[${event.type}]`))
  );
};

const agent = new HttpAgent({ url: "https://agent.example.com" });
agent.use(loggingMiddleware);

await agent.runAgent();
```

## Core Patterns

### Pattern 1: Function-based middleware

A `MiddlewareFunction` receives the `RunAgentInput` and a `next` agent. Call
`next.run(input)` to continue the chain and return the resulting `Observable<BaseEvent>`.
Use RxJS operators to transform the stream.

```typescript
import { MiddlewareFunction } from "@ag-ui/client";
import { RunAgentInput, BaseEvent, EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

const prefixMiddleware: MiddlewareFunction = (input, next) => {
  return next.run(input).pipe(
    map((event) => {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        return { ...event, delta: `[AI] ${event.delta}` };
      }
      return event;
    })
  );
};

// Modify input before passing downstream
const injectContextMiddleware: MiddlewareFunction = (input, next) => {
  const modifiedInput: RunAgentInput = {
    ...input,
    forwardedProps: {
      ...input.forwardedProps,
      timestamp: Date.now(),
    },
  };
  return next.run(modifiedInput);
};

agent.use(prefixMiddleware, injectContextMiddleware);
```

### Pattern 2: Class-based middleware with state tracking

Extend `Middleware` for stateful middleware. Use `this.runNext(input, next)` to
get a normalized event stream (chunk events are auto-expanded to full
START/CONTENT/END sequences). Use `this.runNextWithState(input, next)` to also
receive accumulated `messages` and `state` after each event.

```typescript
import { Middleware } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { RunAgentInput, BaseEvent, EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
import { tap, finalize } from "rxjs/operators";

class MetricsMiddleware extends Middleware {
  private eventCounts = new Map<string, number>();

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    const startTime = Date.now();

    return this.runNext(input, next).pipe(
      tap((event) => {
        const count = this.eventCounts.get(event.type) ?? 0;
        this.eventCounts.set(event.type, count + 1);
      }),
      finalize(() => {
        const duration = Date.now() - startTime;
        console.log(`Run completed in ${duration}ms`);
        console.log("Event counts:", Object.fromEntries(this.eventCounts));
        this.eventCounts.clear();
      })
    );
  }
}

agent.use(new MetricsMiddleware());
```

Using `runNextWithState` for state-aware middleware:

```typescript
import { Middleware, EventWithState } from "@ag-ui/client";
import { AbstractAgent } from "@ag-ui/client";
import { RunAgentInput, BaseEvent, EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";

class StateAwareMiddleware extends Middleware {
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.runNextWithState(input, next).pipe(
      map(({ event, messages, state }: EventWithState) => {
        // messages and state reflect the state AFTER this event was applied
        if (event.type === EventType.TEXT_MESSAGE_END) {
          console.log("Message count after this event:", messages.length);
          console.log("Current state:", state);
        }
        return event;
      })
    );
  }
}
```

### Pattern 3: FilterToolCallsMiddleware

The built-in `FilterToolCallsMiddleware` removes `TOOL_CALL_*` events from the
stream by tool name. Provide either `allowedToolCalls` (allowlist) or
`disallowedToolCalls` (blocklist), never both.

```typescript
import { FilterToolCallsMiddleware } from "@ag-ui/client";

// Allowlist: only these tools pass through
const allowFilter = new FilterToolCallsMiddleware({
  allowedToolCalls: ["search", "calculate"],
});

// Blocklist: these tools are removed from the stream
const blockFilter = new FilterToolCallsMiddleware({
  disallowedToolCalls: ["deleteUser", "dropTable"],
});

agent.use(allowFilter);
// or
agent.use(blockFilter);
```

### Pattern 4: Middleware execution order

Middleware wraps from outside in. `agent.use(a, b, c)` means `a` runs first
(outermost), then `b`, then `c`, then `agent.run()`. Events flow back through
`c`, `b`, `a`.

```typescript
import { MiddlewareFunction } from "@ag-ui/client";
import { tap } from "rxjs/operators";

const outer: MiddlewareFunction = (input, next) => {
  console.log("1. outer: before run");
  return next.run(input).pipe(
    tap(() => console.log("4. outer: event received"))
  );
};

const inner: MiddlewareFunction = (input, next) => {
  console.log("2. inner: before run");
  return next.run(input).pipe(
    tap(() => console.log("3. inner: event received"))
  );
};

agent.use(outer, inner);
await agent.runAgent();

// Output order:
// 1. outer: before run
// 2. inner: before run
// 3. inner: event received    (for each event)
// 4. outer: event received    (for each event)
```

## Common Mistakes

### 1. Expecting middleware to run in connectAgent() (HIGH)

Middleware added with `agent.use()` only runs in `runAgent()`. `connectAgent()`
calls `connect()` directly and does not run middleware.

Wrong:

```typescript
agent.use(loggingMiddleware);
await agent.connectAgent(); // loggingMiddleware is NOT applied
```

Correct:

```typescript
agent.use(loggingMiddleware);
await agent.runAgent(); // loggingMiddleware IS applied
```

### 2. FilterToolCallsMiddleware does not block upstream execution (HIGH)

`FilterToolCallsMiddleware` only filters emitted `TOOL_CALL_*` events from the
stream. It does NOT prevent the upstream LLM from attempting the tool call. The
LLM may still execute the call server-side; the middleware just hides the events
from the client. To truly prevent tool calls, remove tools from
`RunAgentInput.tools` before the run.

Wrong:

```typescript
// Thinking: "The agent won't call deleteUser at all"
agent.use(new FilterToolCallsMiddleware({
  disallowedToolCalls: ["deleteUser"],
}));
// The LLM may still call deleteUser server-side
```

Correct:

```typescript
// Remove tool from input to prevent upstream execution
const safeMiddleware: MiddlewareFunction = (input, next) => {
  const filteredInput = {
    ...input,
    tools: input.tools.filter((t) => t.name !== "deleteUser"),
  };
  return next.run(filteredInput);
};
agent.use(safeMiddleware);
```

### 3. Wrong middleware execution order assumption (MEDIUM)

Middleware wraps from outside in. `agent.use(a, b, c)` means `a` is outermost
and sees events last (after `b` and `c` have processed them). If `a` needs to
see raw events before any transformation, it must be added last, not first.

Wrong:

```typescript
// Wanting rawLogger to see events before transform modifies them
agent.use(rawLogger, transform);
// rawLogger is outermost -- it sees events AFTER transform
```

Correct:

```typescript
// rawLogger added after transform -- it is innermost, sees events first
agent.use(transform, rawLogger);
```

### 4. Blocking operations in middleware (MEDIUM)

Middleware runs in the RxJS pipeline. Synchronous blocking operations (long
loops, sync I/O) block the entire event stream. Use async operations with
RxJS operators.

Wrong:

```typescript
const blockingMiddleware: MiddlewareFunction = (input, next) => {
  return next.run(input).pipe(
    tap((event) => {
      // Blocks the entire stream while writing
      const fs = require("fs");
      fs.writeFileSync("/tmp/log.txt", JSON.stringify(event));
    })
  );
};
```

Correct:

```typescript
import { concatMap } from "rxjs/operators";
import { from } from "rxjs";
import { writeFile } from "fs/promises";

const asyncMiddleware: MiddlewareFunction = (input, next) => {
  return next.run(input).pipe(
    concatMap(async (event) => {
      await writeFile("/tmp/log.txt", JSON.stringify(event));
      return event;
    })
  );
};
```

See also: `agui-implement-abstract-agent`, `agui-tool-calling-events`
