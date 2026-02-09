/**
 * Tools integration tests
 */

import { ClaudeAgent } from '../../src/agent';
import { SessionManager } from '../../src/session-manager';
import type { RunAgentInput } from '@ag-ui/client';

// Mock the Claude SDK
jest.mock('@anthropic-ai/claude-agent-sdk');

describe('Tools Integration', () => {
  let agent: ClaudeAgent;

  beforeEach(() => {
    SessionManager.resetInstance();
    
    const { ClaudeSDKClient } = require('@anthropic-ai/claude-agent-sdk');
    
    ClaudeSDKClient.mockImplementation(() => ({
      query: jest.fn().mockResolvedValue(undefined),
      receiveResponse: jest.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool_call_1',
                name: 'calculator',
                input: { operation: 'add', numbers: [1, 2] },
              },
            ],
          };
          yield {
            type: 'result',
            subtype: 'success',
          };
        },
      }),
      close: jest.fn().mockResolvedValue(undefined),
    }));

    agent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: true,
    });
  });

  afterEach(() => {
    SessionManager.resetInstance();
    jest.clearAllMocks();
  });

  it('should handle tool calls', (done) => {
    const input: RunAgentInput = {
      agentId: 'test_agent',
      messages: [
        { id: 'msg1', role: 'user', content: 'Calculate 1 + 2' },
      ],
      context: {
        tools: [
          {
            name: 'calculator',
            description: 'Performs calculations',
            parameters: {
              type: 'object',
              properties: {
                operation: { type: 'string' },
                numbers: { type: 'array', items: { type: 'number' } },
              },
              required: ['operation', 'numbers'],
            },
          },
        ],
      },
    };

    const events: any[] = [];

    agent.run(input).subscribe({
      next: (event) => {
        events.push(event);
      },
      complete: () => {
        // Check for tool call events
        expect(events.some((e) => e.type === 'tool_call_start')).toBe(true);
        expect(events.some((e) => e.type === 'tool_call_args')).toBe(true);
        expect(events.some((e) => e.type === 'tool_call_end')).toBe(true);
        done();
      },
      error: done,
    });
  });

  it('should handle tool results', (done) => {
    const { ClaudeSDKClient } = require('@anthropic-ai/claude-agent-sdk');
    
    ClaudeSDKClient.mockImplementation(() => ({
      query: jest.fn().mockResolvedValue(undefined),
      receiveResponse: jest.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_call_1',
                content: 'The result is 3',
                is_error: false,
              },
            ],
          };
          yield {
            type: 'result',
            subtype: 'success',
          };
        },
      }),
      close: jest.fn().mockResolvedValue(undefined),
    }));

    const resultAgent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: true,
    });

    const input: RunAgentInput = {
      agentId: 'test_agent',
      messages: [
        { id: 'msg1', role: 'user', content: 'What is 1 + 2?' },
      ],
      context: {
        tools: [
          {
            name: 'calculator',
            description: 'Performs calculations',
          },
        ],
      },
    };

    const events: any[] = [];

    resultAgent.run(input).subscribe({
      next: (event) => {
        events.push(event);
      },
      complete: () => {
        // Check for tool result event
        const resultEvent = events.find((e) => e.type === 'tool_call_result');
        expect(resultEvent).toBeDefined();
        expect(resultEvent?.result).toContain('The result is 3');
        done();
      },
      error: done,
    });
  });

  it('should handle client tools', (done) => {
    const input: RunAgentInput = {
      agentId: 'test_agent',
      messages: [
        { id: 'msg1', role: 'user', content: 'Open a file' },
      ],
      context: {
        tools: [
          {
            name: 'file_reader',
            description: 'Reads files',
            client: true,
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
            },
          },
        ],
      },
    };

    agent.run(input).subscribe({
      complete: done,
      error: done,
    });
  });
});

