/**
 * Mock for @ag-ui/client
 */

export class AbstractAgent {
  run() {}
  cleanup() {}
}

export class TextMessageStartEvent {
  type = 'text_message_start';
  constructor(public messageId: string) {}
}

export class TextMessageContentEvent {
  type = 'text_message_content';
  constructor(public text: string) {}
}

export class TextMessageEndEvent {
  type = 'text_message_end';
  constructor(public messageId: string) {}
}

export class ToolCallStartEvent {
  type = 'tool_call_start';
  constructor(public toolCallId: string, public toolName: string) {}
}

export class ToolCallArgsEvent {
  type = 'tool_call_args';
  constructor(public args: any) {}
}

export class ToolCallEndEvent {
  type = 'tool_call_end';
  constructor(public toolCallId: string) {}
}

export class ToolCallResultEvent {
  type = 'tool_call_result';
  constructor(public result: any) {}
}

export class RunStartedEvent {
  type = 'run_started';
  constructor(public runId: string) {}
}

export class RunFinishedEvent {
  type = 'run_finished';
}

export class RunErrorEvent {
  type = 'run_error';
  constructor(public error: Error) {}
}

export interface RunAgentInput {
  agentId: string;
  threadId?: string;
  messages: Message[];
  context: any;
}

export interface Message {
  id: string;
  role: string;
  content: string | any[];
}

export interface Tool {
  name: string;
  description: string;
  parameters?: any;
  handler?: (...args: any[]) => any;
  client?: boolean;
}

export enum EventType {
  RUN_STARTED = 'run_started',
  RUN_FINISHED = 'run_finished',
  RUN_ERROR = 'run_error',
  TEXT_MESSAGE_START = 'text_message_start',
  TEXT_MESSAGE_CONTENT = 'text_message_content',
  TEXT_MESSAGE_END = 'text_message_end',
  TOOL_CALL_START = 'tool_call_start',
  TOOL_CALL_ARGS = 'tool_call_args',
  TOOL_CALL_END = 'tool_call_end',
  TOOL_CALL_RESULT = 'tool_call_result',
}

