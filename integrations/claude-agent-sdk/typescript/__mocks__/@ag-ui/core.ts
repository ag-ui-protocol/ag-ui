/**
 * Mock for @ag-ui/core
 */

export class BaseEvent {
  type: string = '';
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

