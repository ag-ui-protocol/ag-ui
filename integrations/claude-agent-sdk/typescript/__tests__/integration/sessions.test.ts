/**
 * Sessions integration tests
 */

import { ClaudeAgent } from '../../src/agent';
import { SessionManager } from '../../src/session-manager';
import type { RunAgentInput } from '@ag-ui/client';

// Mock the Claude SDK
jest.mock('@anthropic-ai/claude-agent-sdk');

describe('Sessions Integration', () => {
  beforeEach(() => {
    SessionManager.resetInstance();
    
    const { ClaudeSDKClient, query } = require('@anthropic-ai/claude-agent-sdk');
    
    ClaudeSDKClient.mockImplementation(() => ({
      query: jest.fn().mockResolvedValue(undefined),
      receiveResponse: jest.fn().mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            content: [{ type: 'text', text: 'Response' }],
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
          content: [{ type: 'text', text: 'Response' }],
        };
        yield {
          type: 'result',
          subtype: 'success',
        };
      },
    });
  });

  afterEach(() => {
    SessionManager.resetInstance();
    jest.clearAllMocks();
  });

  it('should maintain persistent sessions', (done) => {
    const agent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: true,
    });

    const input: RunAgentInput = {
      agentId: 'test_agent',
      threadId: 'thread1',
      messages: [
        { id: 'msg1', role: 'user', content: 'Hello' },
      ],
      context: {},
    };

    agent.run(input).subscribe({
      complete: () => {
        expect(agent.getSessionManager().hasSession('thread1')).toBe(true);
        done();
      },
      error: done,
    });
  });

  it('should work in stateless mode', (done) => {
    const agent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: false,
    });

    const input: RunAgentInput = {
      agentId: 'test_agent',
      messages: [
        { id: 'msg1', role: 'user', content: 'Hello' },
      ],
      context: {},
    };

    agent.run(input).subscribe({
      complete: done,
      error: done,
    });
  });

  it('should isolate sessions by thread ID', (done) => {
    const agent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: true,
    });

    const input1: RunAgentInput = {
      agentId: 'test_agent',
      threadId: 'thread1',
      messages: [
        { id: 'msg1', role: 'user', content: 'Hello thread 1' },
      ],
      context: {},
    };

    const input2: RunAgentInput = {
      agentId: 'test_agent',
      threadId: 'thread2',
      messages: [
        { id: 'msg2', role: 'user', content: 'Hello thread 2' },
      ],
      context: {},
    };

    agent.run(input1).subscribe({
      complete: () => {
        agent.run(input2).subscribe({
          complete: () => {
            expect(agent.getSessionManager().hasSession('thread1')).toBe(true);
            expect(agent.getSessionManager().hasSession('thread2')).toBe(true);
            expect(agent.getSessionManager().getSessionCount()).toBe(2);
            done();
          },
          error: done,
        });
      },
      error: done,
    });
  });
});

