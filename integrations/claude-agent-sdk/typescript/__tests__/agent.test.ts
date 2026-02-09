/**
 * Claude Agent tests
 */

import { ClaudeAgent } from '../src/agent';
import { SessionManager } from '../src/session-manager';
import type { RunAgentInput } from '@ag-ui/client';

// Mock the Claude SDK
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  ClaudeSDKClient: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue(undefined),
    receiveResponse: jest.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        };
        yield {
          type: 'result',
          subtype: 'success',
        };
      },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  query: jest.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      };
      yield {
        type: 'result',
        subtype: 'success',
      };
    },
  }),
}));

describe('ClaudeAgent', () => {
  let agent: ClaudeAgent;

  beforeEach(() => {
    SessionManager.resetInstance();
    agent = new ClaudeAgent({
      apiKey: 'test_api_key',
      enablePersistentSessions: true,
    });
  });

  afterEach(() => {
    SessionManager.resetInstance();
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(agent).toBeDefined();
      expect(agent.getSessionManager()).toBeDefined();
      expect(agent.getExecutionStateManager()).toBeDefined();
    });

    it('should use environment variables for API key', () => {
      process.env.ANTHROPIC_API_KEY = 'env_api_key';
      const envAgent = new ClaudeAgent({});
      expect(envAgent).toBeDefined();
      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  describe('run', () => {
    it('should return an observable', () => {
      const input: RunAgentInput = {
        agentId: 'test_agent',
        messages: [
          { id: 'msg1', role: 'user', content: 'Hello' },
        ],
        context: {},
      };

      const observable = agent.run(input);
      expect(observable).toBeDefined();
      expect(typeof observable.subscribe).toBe('function');
    });

    it('should emit run started event', (done) => {
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
          expect(events.length).toBeGreaterThan(0);
          expect(events[0].type).toBe('run_started');
          done();
        },
        error: done,
      });
    });

    it('should emit run finished event', (done) => {
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
          const finishedEvent = events.find((e) => e.type === 'run_finished');
          expect(finishedEvent).toBeDefined();
          done();
        },
        error: done,
      });
    });

    it('should handle tools', (done) => {
      const input: RunAgentInput = {
        agentId: 'test_agent',
        messages: [
          { id: 'msg1', role: 'user', content: 'Hello' },
        ],
        context: {
          tools: [
            {
              name: 'test_tool',
              description: 'A test tool',
              parameters: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
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

  describe('abortExecution', () => {
    it('should abort running execution', (done) => {
      const input: RunAgentInput = {
        agentId: 'test_agent',
        messages: [
          { id: 'msg1', role: 'user', content: 'Hello' },
        ],
        context: {},
      };

      let runId: string;

      agent.run(input).subscribe({
        next: (event: any) => {
          if (event.type === 'run_started') {
            runId = event.runId;
            agent.abortExecution(runId);
          }
        },
        complete: () => {
          if (runId) {
            const execution = agent.getExecutionState(runId);
            expect(execution?.isAborted()).toBe(true);
          }
          done();
        },
        error: done,
      });
    });
  });

  describe('cleanup', () => {
    it('should cleanup resources', async () => {
      await agent.cleanup();

      expect(agent.getSessionManager().getSessionCount()).toBe(0);
      expect(agent.getExecutionStateManager().getExecutionCount()).toBe(0);
    });
  });

  describe('persistent sessions', () => {
    it('should reuse session for same thread', (done) => {
      const input1: RunAgentInput = {
        agentId: 'test_agent',
        threadId: 'thread1',
        messages: [
          { id: 'msg1', role: 'user', content: 'Hello' },
        ],
        context: {},
      };

      const input2: RunAgentInput = {
        agentId: 'test_agent',
        threadId: 'thread1',
        messages: [
          { id: 'msg1', role: 'user', content: 'Hello' },
          { id: 'msg2', role: 'assistant', content: 'Hi' },
          { id: 'msg3', role: 'user', content: 'How are you?' },
        ],
        context: {},
      };

      agent.run(input1).subscribe({
        complete: () => {
          const sessionCount1 = agent.getSessionManager().getSessionCount();

          agent.run(input2).subscribe({
            complete: () => {
              const sessionCount2 = agent.getSessionManager().getSessionCount();
              expect(sessionCount2).toBe(sessionCount1);
              done();
            },
            error: done,
          });
        },
        error: done,
      });
    });
  });

  describe('stateless mode', () => {
    it('should work in stateless mode', (done) => {
      const statelessAgent = new ClaudeAgent({
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

      statelessAgent.run(input).subscribe({
        complete: done,
        error: done,
      });
    });
  });
});

