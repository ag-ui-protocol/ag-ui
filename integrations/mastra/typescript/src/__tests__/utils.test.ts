import type { AssistantMessage, DeveloperMessage, ToolMessage, UserMessage } from '@ag-ui/client';
import { describe, expect, test } from 'bun:test';
import { buildToolNameIndex, convertAGUIMessagesToMastra, toMastraUserContent } from '../utils';
import { TOOL_CALL_ID, TOOL_NAME } from './mock';

// ---------------------------------------------------------------------------

describe('mastra-agui/utils', () => {
  describe('buildToolNameIndex', () => {
    test('extracts toolCallId → toolName mapping from assistant messages', () => {
      const messages: AssistantMessage[] = [
        {
          id: 'id-ass',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              type: 'function' as const,
              id: TOOL_CALL_ID,
              function: { name: TOOL_NAME, arguments: '{}' },
            },
          ],
        },
      ];

      const index = buildToolNameIndex(messages);

      expect(index.get(TOOL_CALL_ID)).toBe(TOOL_NAME);
    });
  });

  describe('toMastraUserContent', () => {
    test('string content is returned as-is', () => {
      expect(toMastraUserContent('hello')).toBe('hello');
    });

    test('empty content returns empty string', () => {
      expect(toMastraUserContent('')).toBe('');
    });
  });

  describe('convertAGUIMessagesToMastra', () => {
    test('U1: developer role → outputs role:system (BUG-3 fix)', () => {
      const messages: DeveloperMessage[] = [
        { id: 'id-dev', role: 'developer', content: 'You are a versatile assistant.' },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('system');
      expect(result[0].type).toBe('text');
      expect(result[0].id).toBe('id-dev');
      expect(result[0].content).toBe('You are a versatile assistant.');
    });

    test('U2: assistant + toolCalls → type:tool-call, ids/names/args all correct', () => {
      const messages: AssistantMessage[] = [
        {
          id: 'id-ass',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              type: 'function' as const,
              id: TOOL_CALL_ID,
              function: {
                name: TOOL_NAME,
                arguments: JSON.stringify({ inputData: { city: 'Beijing' } }),
              },
            },
          ],
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('tool-call');
      expect(result[0].role).toBe('assistant');

      expect(result[0].toolCallIds).toEqual([TOOL_CALL_ID]);
      expect(result[0].toolNames).toEqual([TOOL_NAME]);
      expect(result[0].toolCallArgs).toEqual([{ inputData: { city: 'Beijing' } }]);
    });

    test('U3: tool role → toolName resolved via O(1) Map lookup (BUG-1 fix)', () => {
      const messages = [
        {
          id: 'id-ass',
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            {
              type: 'function' as const,
              id: TOOL_CALL_ID,
              function: { name: TOOL_NAME, arguments: '{}' },
            },
          ],
        } satisfies AssistantMessage,
        {
          id: 'id-tool',
          role: 'tool' as const,
          toolCallId: TOOL_CALL_ID,
          content: JSON.stringify({ result: { location: 'Beijing', temperature: 22 } }),
        } satisfies ToolMessage,
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result[1]).toHaveProperty('content[0].toolName', TOOL_NAME);
      expect(result[1]).toHaveProperty('content[0].toolCallId', TOOL_CALL_ID);
    });

    test('U4: orphan tool role (no matching assistant) → toolName = "unknown"', () => {
      const messages: ToolMessage[] = [
        {
          id: 'id-orphan',
          role: 'tool',
          toolCallId: 'no-such-id',
          content: 'some result',
        },
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('content[0].toolName', 'unknown');
    });

    test('U5: full multi-turn conversation → order/id/content all correct (BUG-13 id preserved)', () => {
      const messages = [
        {
          id: 'id-dev',
          role: 'developer' as const,
          content: 'You are a versatile assistant.',
        } satisfies DeveloperMessage,
        {
          id: 'id-usr1',
          role: 'user' as const,
          content: "What's the weather like in Beijing today?",
        } satisfies UserMessage,
        {
          id: 'id-ass1',
          role: 'assistant' as const,
          content: '',
          toolCalls: [
            {
              type: 'function' as const,
              id: TOOL_CALL_ID,
              function: {
                name: TOOL_NAME,
                arguments: JSON.stringify({ inputData: { city: 'Beijing' } }),
              },
            },
          ],
        } satisfies AssistantMessage,
        {
          id: 'id-tool',
          role: 'tool' as const,
          toolCallId: TOOL_CALL_ID,
          content: JSON.stringify({
            result: {
              location: 'Beijing',
              temperature: 22,
              feelsLike: 20,
              humidity: 55,
              windSpeed: 12,
              condition: 'Sunny',
            },
          }),
        } satisfies ToolMessage,
        {
          id: 'id-ass2',
          role: 'assistant' as const,
          content: 'Beijing weather is sunny today, temperature 22°C.',
        } satisfies AssistantMessage,
      ];

      const result = convertAGUIMessagesToMastra(messages);

      expect(result).toHaveLength(5);

      // BUG-13: 保留原始 id
      expect(result[0].id).toBe('id-dev');
      expect(result[1].id).toBe('id-usr1');
      expect(result[2].id).toBe('id-ass1');
      expect(result[3].id).toBe('id-tool');
      expect(result[4].id).toBe('id-ass2');

      // BUG-3: developer 角色转换为 system
      expect(result[0].role).toBe('system');
      expect(result[0].type).toBe('text');

      // 用户消息
      expect(result[1].role).toBe('user');
      expect(result[1].type).toBe('text');

      // assistant 工具调用
      expect(result[2].role).toBe('assistant');
      expect(result[2].type).toBe('tool-call');
      expect(result[2].toolNames).toEqual([TOOL_NAME]);

      // 工具结果
      expect(result[3].role).toBe('tool');
      expect(result[3].type).toBe('tool-result');
      expect(result[3]).toHaveProperty('content[0].toolName', TOOL_NAME);

      // 纯文本 assistant 消息
      expect(result[4].role).toBe('assistant');
      expect(result[4].type).toBe('text');
      expect(result[4].content).toBe('Beijing weather is sunny today, temperature 22°C.');
    });
  });
}); // mastra-agui/utils
