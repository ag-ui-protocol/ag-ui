/**
 * Mock for @anthropic-ai/claude-agent-sdk
 */

export const ClaudeSDKClient = jest.fn().mockImplementation(() => ({
  query: jest.fn().mockResolvedValue(undefined),
  receiveResponse: jest.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: 'Hello from mock' }],
      };
      yield {
        type: 'result',
        subtype: 'success',
      };
    },
  }),
  close: jest.fn().mockResolvedValue(undefined),
}));

export const query = jest.fn().mockImplementation(async function* () {
  yield {
    type: 'assistant',
    content: [{ type: 'text', text: 'Hello from mock query' }],
  };
  yield {
    type: 'result',
    subtype: 'success',
  };
});

export const createSdkMcpServer = jest.fn().mockResolvedValue({
  name: 'mock-server',
  version: '1.0.0',
});

export class SdkMcpTool {
  constructor(public config: any) {}
}

