/**
 * Basic integration tests
 */

import { ClaudeAgent } from '../../src/agent';
import { SessionManager } from '../../src/session-manager';
import type { RunAgentInput } from '@ag-ui/client';

// Mock the Claude SDK
jest.mock('@anthropic-ai/claude-agent-sdk');

describe('Basic Integration', () => {
  let agent: ClaudeAgent;

  beforeEach(() => {
    SessionManager.resetInstance();
    
    const { ClaudeSDKClient, query } = require('@anthropic-ai/claude-agent-sdk');
    
    ClaudeSDKClient.mockImplementation(() => ({
      query: jest.fn().mockResolvedValue(undefined),
      receiveResponse: jest.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            content: [{ type: 'text', text: 'Hello! How can I help you?' }],
          };
          yield {
            type: 'result',
            subtype: 'success',
          };
        },
      }),
      close: jest.fn().mockResolvedValue(undefined),
    }));

    query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help you?' }],
        };
        yield {
          type: 'result',
          subtype: 'success',
        };
      },
    });

    agent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: true,
    });
  });

  afterEach(() => {
    SessionManager.resetInstance();
    jest.clearAllMocks();
  });

  it('should handle simple conversation', (done) => {
    const input: RunAgentInput = {
      agentId: 'test_agent',
      messages: [
        { id: 'msg1', role: 'user', content: 'Hello' },
      ],
      context: {},
    };

    const events: any[] = [];

    agent.run(input).subscribe({
      next: (event) => {
        events.push(event);
      },
      complete: () => {
        // Check that we received key events
        expect(events.some((e) => e.type === 'run_started')).toBe(true);
        expect(events.some((e) => e.type === 'text_message_start')).toBe(true);
        expect(events.some((e) => e.type === 'text_message_content')).toBe(true);
        expect(events.some((e) => e.type === 'text_message_end')).toBe(true);
        expect(events.some((e) => e.type === 'run_finished')).toBe(true);
        done();
      },
      error: done,
    });
  });

  it('should handle multi-turn conversation', (done) => {
    const input1: RunAgentInput = {
      agentId: 'test_agent',
      threadId: 'thread1',
      messages: [
        { id: 'msg1', role: 'user', content: 'Hello' },
      ],
      context: {},
    };

    agent.run(input1).subscribe({
      complete: () => {
        const input2: RunAgentInput = {
          agentId: 'test_agent',
          threadId: 'thread1',
          messages: [
            { id: 'msg1', role: 'user', content: 'Hello' },
            { id: 'msg2', role: 'assistant', content: 'Hello! How can I help you?' },
            { id: 'msg3', role: 'user', content: 'Tell me a joke' },
          ],
          context: {},
        };

        agent.run(input2).subscribe({
          complete: () => {
            // Verify session was reused
            expect(agent.getSessionManager().getSessionCount()).toBe(1);
            done();
          },
          error: done,
        });
      },
      error: done,
    });
  });

  it('should handle errors gracefully', (done) => {
    const { ClaudeSDKClient } = require('@anthropic-ai/claude-agent-sdk');
    
    ClaudeSDKClient.mockImplementation(() => ({
      query: jest.fn().mockRejectedValue(new Error('API Error')),
      receiveResponse: jest.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          throw new Error('API Error');
        },
      }),
      close: jest.fn().mockResolvedValue(undefined),
    }));

    const errorAgent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: true,
    });

    const input: RunAgentInput = {
      agentId: 'test_agent',
      messages: [
        { id: 'msg1', role: 'user', content: 'Hello' },
      ],
      context: {},
    };

    const events: any[] = [];

    errorAgent.run(input).subscribe({
      next: (event) => {
        events.push(event);
      },
      complete: () => {
        // Should have error event
        expect(events.some((e) => e.type === 'run_error')).toBe(true);
        done();
      },
      error: done,
    });
  });
});

