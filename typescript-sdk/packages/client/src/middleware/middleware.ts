import { AbstractAgent } from "@/agent";
import { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { Observable } from "rxjs";

export type MiddlewareFunction = (input: RunAgentInput, next: AbstractAgent) => Observable<BaseEvent>;

export abstract class Middleware {
  abstract run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent>;
}

// Wrapper class to convert a function into a Middleware instance
export class FunctionMiddleware extends Middleware {
  constructor(private fn: MiddlewareFunction) {
    super();
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return this.fn(input, next);
  }
}
