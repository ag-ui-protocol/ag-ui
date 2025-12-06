/**
 * Event translator tests
 */

import { EventTranslator } from '../src/event-translator';
import { EventType } from '@ag-ui/client';
import type {
  SDKAssistantMessage,
  SDKResultMessage,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../src/types';

describe('EventTranslator', () => {
  let translator: EventTranslator;
  const runId = 'test_run_1';

  beforeEach(() => {
    translator = new EventTranslator(runId);
  });

  describe('translateMessage', () => {
    it('should translate assistant message with text block', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Hello, world!',
          } as TextBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe(EventType.TEXT_MESSAGE_START);
      expect(events[1].type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(events[2].type).toBe(EventType.TEXT_MESSAGE_END);
    });

    it('should translate assistant message with tool use block', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'search',
            input: { query: 'test' },
          } as ToolUseBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(3);
      expect(events[0].type).toBe(EventType.TOOL_CALL_START);
      expect(events[1].type).toBe(EventType.TOOL_CALL_ARGS);
      expect(events[2].type).toBe(EventType.TOOL_CALL_END);
    });

    it('should translate assistant message with tool result block', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_1',
            content: 'Result data',
            is_error: false,
          } as ToolResultBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.TOOL_CALL_RESULT);
    });

    it('should translate result message (success)', () => {
      const message: SDKResultMessage = {
        type: 'result',
        subtype: 'success',
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.RUN_FINISHED);
    });

    it('should translate result message (error)', () => {
      const message: SDKResultMessage = {
        type: 'result',
        subtype: 'error',
        error: {
          type: 'Error',
          message: 'Something went wrong',
        },
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(EventType.RUN_ERROR);
    });
  });

  describe('translateTextBlock', () => {
    it('should generate text message events', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Test content',
          } as TextBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(3);
      
      const startEvent = events[0] as any;
      expect(startEvent.type).toBe(EventType.TEXT_MESSAGE_START);
      expect(startEvent.messageId).toBeDefined();

      const contentEvent = events[1] as any;
      expect(contentEvent.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
      expect(contentEvent.content).toBe('Test content');

      const endEvent = events[2] as any;
      expect(endEvent.type).toBe(EventType.TEXT_MESSAGE_END);
    });
  });

  describe('translateToolUseBlock', () => {
    it('should generate tool call events', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_123',
            name: 'calculator',
            input: { operation: 'add', numbers: [1, 2] },
          } as ToolUseBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(3);

      const startEvent = events[0] as any;
      expect(startEvent.type).toBe(EventType.TOOL_CALL_START);
      expect(startEvent.toolCallId).toBe('call_123');
      expect(startEvent.toolName).toBe('calculator');

      const argsEvent = events[1] as any;
      expect(argsEvent.type).toBe(EventType.TOOL_CALL_ARGS);
      expect(argsEvent.toolCallId).toBe('call_123');
      expect(argsEvent.args).toBe(JSON.stringify({ operation: 'add', numbers: [1, 2] }));

      const endEvent = events[2] as any;
      expect(endEvent.type).toBe(EventType.TOOL_CALL_END);
      expect(endEvent.toolCallId).toBe('call_123');
    });
  });

  describe('translateToolResultBlock', () => {
    it('should generate tool result event with string content', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: 'Result: 3',
            is_error: false,
          } as ToolResultBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(1);

      const resultEvent = events[0] as any;
      expect(resultEvent.type).toBe(EventType.TOOL_CALL_RESULT);
      expect(resultEvent.toolCallId).toBe('call_123');
      expect(resultEvent.result).toBe('Result: 3');
      expect(resultEvent.isError).toBe(false);
    });

    it('should generate tool result event with array content', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: [
              { type: 'text', text: 'Part 1' },
              { type: 'text', text: 'Part 2' },
            ],
            is_error: false,
          } as ToolResultBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(1);

      const resultEvent = events[0] as any;
      expect(resultEvent.type).toBe(EventType.TOOL_CALL_RESULT);
      expect(resultEvent.result).toContain('Part 1');
      expect(resultEvent.result).toContain('Part 2');
    });

    it('should mark error results', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: 'Error occurred',
            is_error: true,
          } as ToolResultBlock,
        ],
      };

      const events = translator.translateMessage(message);

      expect(events).toHaveLength(1);

      const resultEvent = events[0] as any;
      expect(resultEvent.isError).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset translator state', () => {
      translator.setCurrentMessageId('msg_1');
      translator.reset();

      expect(translator.getCurrentMessageId()).toBeNull();
    });
  });

  describe('generateMessageId', () => {
    it('should generate unique message IDs', () => {
      const message: SDKAssistantMessage = {
        type: 'assistant',
        content: [
          { type: 'text', text: 'Text 1' } as TextBlock,
          { type: 'text', text: 'Text 2' } as TextBlock,
        ],
      };

      const events = translator.translateMessage(message);

      const messageId1 = (events[0] as any).messageId;
      const messageId2 = (events[3] as any).messageId;

      expect(messageId1).not.toBe(messageId2);
    });
  });
});

