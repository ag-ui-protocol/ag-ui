import { AbstractAgent, BaseEvent, RunAgentInput } from "@ag-ui/client";
import { Observable, firstValueFrom, toArray } from "rxjs";

/**
 * Mock Agent for testing middleware
 */
export class MockAgent extends AbstractAgent {
  private events: BaseEvent[];
  public runCalls: RunAgentInput[] = [];

  constructor(events: BaseEvent[] = []) {
    super();
    this.events = events;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    this.runCalls.push(input);
    return new Observable((subscriber) => {
      for (const event of this.events) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  setEvents(events: BaseEvent[]): void {
    this.events = events;
  }
}

/**
 * Create a basic RunAgentInput for testing
 */
export function createRunAgentInput(
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: "test-thread",
    runId: "test-run",
    tools: [],
    context: [],
    forwardedProps: {},
    state: {},
    messages: [],
    ...overrides,
  };
}

/**
 * Collect all events from an Observable
 */
export async function collectEvents(
  observable: Observable<BaseEvent>,
): Promise<BaseEvent[]> {
  return firstValueFrom(observable.pipe(toArray()));
}
