/**
 * Example usage of middleware with AbstractAgent
 * This file demonstrates both class-based and function-based middleware
 */

import { AbstractAgent } from "@/agent";
import { Middleware, MiddlewareFunction } from "@/middleware";
import { RunAgentInput, BaseEvent, EventType } from "@ag-ui/core";
import { Observable } from "rxjs";
import { map, tap } from "rxjs/operators";

// Example agent
class MyAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable(subscriber => {
      subscriber.next({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
      // ... agent logic ...
      subscriber.next({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
      subscriber.complete();
    });
  }
}

// 1. Function-based middleware (simple and concise)
const loggingMiddleware: MiddlewareFunction = (input, next) => {
  console.log('Request:', input);
  return next.run(input).pipe(
    tap(event => console.log('Event:', event))
  );
};

// 2. Another function middleware
const timingMiddleware: MiddlewareFunction = (input, next) => {
  const start = Date.now();
  return next.run(input).pipe(
    tap({
      complete: () => console.log(`Execution took ${Date.now() - start}ms`)
    })
  );
};

// 3. Class-based middleware (when you need state or complex logic)
class AuthMiddleware extends Middleware {
  constructor(private apiKey: string) {
    super();
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Add auth to context
    const authenticatedInput = {
      ...input,
      context: [...input.context, { apiKey: this.apiKey }]
    };
    return next.run(authenticatedInput);
  }
}

// Usage
async function example() {
  const agent = new MyAgent();

  // Can use function middleware directly
  agent.use(loggingMiddleware);

  // Can chain multiple middleware (functions and classes)
  agent.use(
    timingMiddleware,
    new AuthMiddleware('my-api-key'),
    (input, next) => {
      // Inline function middleware
      console.log('Processing request...');
      return next.run(input);
    }
  );

  // Run the agent - middleware will be applied automatically
  await agent.runAgent();
}