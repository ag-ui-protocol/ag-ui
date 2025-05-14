import {
  AbstractAgent,
  RunAgent,
  RunAgentInput,
  EventType,
  BaseEvent,
} from "@agentwire/client";
import { Observable, from, of } from "rxjs";

export class YourCustomAgent extends AbstractAgent {
  protected run(input: RunAgentInput): RunAgent {
    return () => {
      const messages = input.messages;
      const response = "Hello world";
      const messageId = Date.now().toString();
      return new Observable<BaseEvent>((observer) => {
        observer.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        } as any);

        observer.next({
          type: EventType.TEXT_MESSAGE_START,
          messageId,
        } as any);

        observer.next({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: response,
        } as any);

        observer.next({
          type: EventType.TEXT_MESSAGE_END,
          messageId,
        } as any);

        observer.next({
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        } as any);

        observer.complete();
      });
    };
  }
}
