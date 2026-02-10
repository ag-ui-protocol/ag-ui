declare module "@ag-ui/client" {
  export interface Tool {
    name: string;
    description: string;
    parameters: any;
  }

  export interface RunAgentInput {
    messages: any[];
    tools?: Tool[];
    threadId?: string;
    runId?: string;
  }

  export enum EventType {
    RUN_STARTED = "run_started",
    RUN_FINISHED = "run_finished",
    TEXT_MESSAGE_START = "text_message_start",
    TEXT_MESSAGE_CONTENT = "text_message_content",
    TEXT_MESSAGE_END = "text_message_end",
    TOOL_CALL_START = "tool_call_start",
    TOOL_CALL_END = "tool_call_end",
  }

  export interface AGUIEvent {
    type: EventType;
    timestamp: Date;
    [key: string]: any;
  }

  export abstract class AbstractAgent {
    abstract run(input: RunAgentInput): Observable<AGUIEvent>;
  }

  export { Observable } from "rxjs";
}
