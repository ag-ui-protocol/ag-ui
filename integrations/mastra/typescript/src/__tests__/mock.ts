import { randomUUID } from '@ag-ui/client';
import type { BaseEvent, RunAgentInput } from '@ag-ui/client';
import type { Agent as LocalMastraAgent } from '@mastra/core/agent';
import type { MastraMemory, StorageThreadType } from '@mastra/core/memory';
import { ChunkFrom } from '@mastra/core/stream';
import type { ChunkType, MastraModelOutput } from '@mastra/core/stream';
import { MastraAgentAdapter } from '../mastra';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 每次测试进程生成一次，在本模块的所有 fixture 中保持一致。 */
export const THREAD_ID = randomUUID();
export const RESOURCE_ID = randomUUID();

/** 来自真实录制 agent 运行的 trace 常量。 */
export const TOOL_CALL_ID = 'call_LpOMtXXfQeMpQY9Cbaa7kwdt';
export const TOOL_NAME = 'workflow-example_mock_weatherWorkflow';

// ---------------------------------------------------------------------------
// Chunk 数据桩
// ---------------------------------------------------------------------------

export function makeReadableStream(chunks: ChunkType[]): ReadableStream<ChunkType> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

export const textChunk: ChunkType = {
  type: 'text-delta',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { id: randomUUID(), text: 'Beijing weather is sunny today, temperature 22°C.' },
};

export const toolCallChunk: ChunkType = {
  type: 'tool-call',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: {
    toolCallId: TOOL_CALL_ID,
    toolName: TOOL_NAME,
    args: { inputData: { city: 'Beijing' } } as Record<string, unknown>,
  },
};

/** 携带服务端分配 messageId 的 step-start chunk（T3 验证）。 */
export const stepStartChunkWithId: ChunkType = {
  type: 'step-start',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { messageId: 'server-msg-id', request: {} },
};

export const finishChunk: ChunkType = {
  type: 'finish',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: {
    stepResult: { reason: 'stop' },
    output: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    metadata: {},
    messages: { all: [], user: [], nonUser: [] },
  },
};

export const errorChunk: ChunkType = {
  type: 'error',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { error: new Error('LLM timeout') },
};

// ---------------------------------------------------------------------------
// 完整流 chunk 数据桩（镜像真实录制的 agent 运行）
// ---------------------------------------------------------------------------

/** text-start / text-delta / text-end 共享的文本消息 ID。 */
export const TEXT_MSG_ID = randomUUID();

/** start chunk — agent 的第一个事件，携带 agentId 和 messageId。 */
export const startChunk: ChunkType = {
  type: 'start',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { id: 'test-agent', messageId: 'server-msg-id' },
};

/** 完整工具调用参数到达前的流式开始标记。 */
export const toolCallStreamingStartChunk: ChunkType = {
  type: 'tool-call-input-streaming-start',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { toolCallId: TOOL_CALL_ID, toolName: TOOL_NAME },
};

/** 增量参数分片（简化为 2 个 chunk）。 */
export const toolCallDeltaChunks: ChunkType[] = [
  {
    type: 'tool-call-delta',
    runId: THREAD_ID,
    from: ChunkFrom.AGENT,
    payload: { argsTextDelta: '{"inputData":', toolCallId: TOOL_CALL_ID, toolName: TOOL_NAME },
  },
  {
    type: 'tool-call-delta',
    runId: THREAD_ID,
    from: ChunkFrom.AGENT,
    payload: { argsTextDelta: '{"city":"Beijing"}}', toolCallId: TOOL_CALL_ID },
  },
];

/** 标记流式参数结束。 */
export const toolCallStreamingEndChunk: ChunkType = {
  type: 'tool-call-input-streaming-end',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { toolCallId: TOOL_CALL_ID },
};

/** 来自 USER 的 tool-output chunk，携带嵌套工作流管道事件。 */
export const toolOutputChunks: ChunkType[] = [
  {
    type: 'tool-output',
    runId: THREAD_ID,
    from: ChunkFrom.USER,
    payload: {
      output: {
        type: 'workflow-start',
        runId: THREAD_ID,
        from: ChunkFrom.WORKFLOW,
        payload: { workflowId: 'example_mock_weatherWorkflow' },
      },
      toolCallId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
    },
  },
  {
    type: 'tool-output',
    runId: THREAD_ID,
    from: ChunkFrom.USER,
    payload: {
      output: {
        type: 'workflow-finish',
        runId: THREAD_ID,
        from: ChunkFrom.WORKFLOW,
        payload: {
          workflowStatus: 'success',
          output: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
          metadata: {},
        },
      },
      toolCallId: TOOL_CALL_ID,
      toolName: TOOL_NAME,
    },
  },
];

/** 来自 AGENT 的 tool-result，触发 AG-UI 中的 TOOL_CALL_RESULT 事件。 */
export const toolResultChunk: ChunkType = {
  type: 'tool-result',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: {
    toolCallId: TOOL_CALL_ID,
    toolName: TOOL_NAME,
    result: {
      location: 'Beijing',
      condition: 'Sunny',
      temperature: 22,
      humidity: 55,
      windSpeed: 12,
    },
    args: { inputData: { city: 'Beijing' } } as Record<string, unknown>,
  },
};

/** 第一步结束时的 step-finish（reason: tool-calls，继续执行下一步）。 */
export const stepFinishWithToolCalls: ChunkType = {
  type: 'step-finish',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: {
    messageId: 'server-msg-id',
    stepResult: { reason: 'tool-calls', isContinued: true },
    output: {
      text: '',
      toolCalls: [],
      usage: { inputTokens: 821, outputTokens: 50, totalTokens: 871 },
    },
    metadata: {},
  },
};

/** 最终助手回复的 text-start，必须与 text-delta 共享 TEXT_MSG_ID。 */
export const textStartChunk: ChunkType = {
  type: 'text-start',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { id: TEXT_MSG_ID },
};

/** 完整流测试用的 text-delta，关联到 TEXT_MSG_ID。 */
export const textDeltaChunk: ChunkType = {
  type: 'text-delta',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { id: TEXT_MSG_ID, text: 'Beijing weather today: Sunny, 22°C, humidity 55%.' },
};

/** 标记文本流结束，关闭 TEXT_MSG_ID 消息。 */
export const textEndChunk: ChunkType = {
  type: 'text-end',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: { id: TEXT_MSG_ID },
};

/** 最终步骤结束时的 step-finish（reason: stop，不再继续）。 */
export const stepFinishWithStop: ChunkType = {
  type: 'step-finish',
  runId: THREAD_ID,
  from: ChunkFrom.AGENT,
  payload: {
    messageId: 'server-msg-id',
    stepResult: { reason: 'stop', isContinued: false },
    output: {
      text: 'Beijing weather today: Sunny, 22°C, humidity 55%.',
      toolCalls: [],
      usage: { inputTokens: 1735, outputTokens: 45, totalTokens: 1780 },
    },
    metadata: {},
  },
};

/**
 * 镜像真实录制 agent 运行的完整 chunk 序列：
 * start → step-start → 工具调用流式传输 → tool-call → workflow tool-output ×2
 * → tool-result → step-finish(tool-calls) → step-start → 文本流式传输 → step-finish(stop) → finish
 */
export const fullStreamChunks: ChunkType[] = [
  startChunk,
  stepStartChunkWithId, // 第一步：同步 messageId → 'server-msg-id'
  toolCallStreamingStartChunk,
  ...toolCallDeltaChunks,
  toolCallStreamingEndChunk,
  toolCallChunk, // → 触发 TOOL_CALL_START + TOOL_CALL_ARGS + TOOL_CALL_END
  ...toolOutputChunks, // 来自 USER 的工作流事件（registry 不处理）
  toolResultChunk, // → 触发 TOOL_CALL_RESULT
  stepFinishWithToolCalls, // 第一步结束，isContinued = true
  stepStartChunkWithId, // 第二步：继承相同的 messageId
  textStartChunk, // registry 不处理
  textDeltaChunk, // → 触发 TEXT_MESSAGE_CHUNK
  textEndChunk, // registry 不处理
  stepFinishWithStop, // 第二步结束，reason: stop
  finishChunk, // → 轮换 messageId
];

// ---------------------------------------------------------------------------
// Mock 辅助函数
// ---------------------------------------------------------------------------

export const mockThread: StorageThreadType = {
  id: THREAD_ID,
  resourceId: RESOURCE_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
  metadata: {},
};

export function makeLocalAgent(
  chunks: ChunkType[],
  memoryOverride?: Partial<{
    getThreadById: MastraMemory['getThreadById'];
    saveThread: MastraMemory['saveThread'];
    getWorkingMemory: MastraMemory['getWorkingMemory'];
  }>,
): LocalMastraAgent {
  const mockMemory = {
    getThreadById: async (): Promise<StorageThreadType | null> => mockThread,
    saveThread: async (args: { thread: StorageThreadType }): Promise<StorageThreadType> =>
      args.thread,
    getWorkingMemory: async (): Promise<string | null> => null,
    ...memoryOverride,
  } as unknown as MastraMemory;

  return {
    getMemory: async (): Promise<MastraMemory> => mockMemory,
    stream: async (): Promise<MastraModelOutput> =>
      ({ fullStream: makeReadableStream(chunks) }) as unknown as MastraModelOutput,
  } as unknown as LocalMastraAgent;
}

export function makeInput(overrides?: Partial<RunAgentInput>): RunAgentInput {
  return {
    threadId: THREAD_ID,
    runId: THREAD_ID,
    messages: [
      { id: randomUUID(), role: 'developer', content: 'You are a versatile assistant.' },
      { id: randomUUID(), role: 'user', content: "What's the weather like in Beijing today?" },
    ],
    tools: [],
    context: [],
    ...overrides,
  };
}

export function collectEvents(
  adapter: MastraAgentAdapter,
  input: RunAgentInput,
): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    adapter.run(input).subscribe({
      next: (e) => events.push(e),
      error: reject,
      complete: () => resolve(events),
    });
  });
}

export function collectEventsWithError(
  adapter: MastraAgentAdapter,
  input: RunAgentInput,
): Promise<{ events: BaseEvent[]; error: Error }> {
  return new Promise((resolve) => {
    const events: BaseEvent[] = [];
    adapter.run(input).subscribe({
      next: (e) => events.push(e),
      error: (err: unknown) =>
        resolve({ events, error: err instanceof Error ? err : new Error(String(err)) }),
      complete: () => resolve({ events, error: new Error('Expected error but got complete') }),
    });
  });
}

export function makeAdapter(agent: LocalMastraAgent): MastraAgentAdapter {
  return new MastraAgentAdapter({
    agentId: 'test-agent',
    agent,
    resourceId: RESOURCE_ID,
  });
}

/**
 * 创建 stream 方法抛出 'LLM timeout' 的本地代理存根（T6 使用）。
 */
export function makeErroringAgent(): LocalMastraAgent {
  const mockMemory = {
    getThreadById: async (): Promise<StorageThreadType | null> => mockThread,
    saveThread: async (args: { thread: StorageThreadType }): Promise<StorageThreadType> =>
      args.thread,
    getWorkingMemory: async (): Promise<string | null> => null,
  } as unknown as MastraMemory;

  return {
    getMemory: async (): Promise<MastraMemory> => mockMemory,
    stream: async (): Promise<MastraModelOutput> => {
      throw new Error('LLM timeout');
    },
  } as unknown as LocalMastraAgent;
}

/**
 * 创建无 getMemory 属性的远端代理存根，processDataStream 按序回放给定 chunks（T8 使用）。
 */
export function makeRemoteAgent(chunks: ChunkType[]): LocalMastraAgent {
  return {
    stream: async (): Promise<{
      processDataStream: (opts: { onChunk: (chunk: ChunkType) => Promise<void> }) => Promise<void>;
    }> => ({
      processDataStream: async (opts) => {
        for (const chunk of chunks) {
          await opts.onChunk(chunk);
        }
      },
    }),
  } as unknown as LocalMastraAgent;
}

/** Mastra 运行时接口的最小存根类型，供 T10/T11 工厂方法测试使用。 */
export type MastraLike = Parameters<typeof MastraAgentAdapter.getLocalAgent>[0]['mastra'];
