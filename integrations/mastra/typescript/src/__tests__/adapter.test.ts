import type {
  StateSnapshotEvent,
  TextMessageChunkEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from '@ag-ui/client';
import { EventType } from '@ag-ui/client';
import { describe, expect, test } from 'bun:test';
import { MastraAgent, type MastraAgentConfig, type MastraAgentOptions } from '..';
import { MastraAgentAdapter } from '../mastra';
import {
  collectEvents,
  collectEventsWithError,
  errorChunk,
  finishChunk,
  fullStreamChunks,
  makeAdapter,
  makeErroringAgent,
  makeInput,
  makeLocalAgent,
  mockThread,
  makeRemoteAgent,
  RESOURCE_ID,
  stepStartChunkWithId,
  textChunk,
  TOOL_CALL_ID,
  TOOL_NAME,
  toolCallChunk,
  type MastraLike,
} from './mock';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MastraAgentAdapter — run() local agent', () => {
  test('T1: text-only stream → correct event order, subscriber.complete', async () => {
    const agent = makeLocalAgent([textChunk, finishChunk]);
    const adapter = makeAdapter(agent);
    const events = await collectEvents(adapter, makeInput());

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)).toBe(true);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test('T2: tool-call chunk → TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END triple events', async () => {
    const agent = makeLocalAgent([stepStartChunkWithId, toolCallChunk, finishChunk]);
    const adapter = makeAdapter(agent);
    const events = await collectEvents(adapter, makeInput());

    const startEvent = events.find(
      (e): e is ToolCallStartEvent => e.type === EventType.TOOL_CALL_START,
    );
    const argsEvent = events.find(
      (e): e is ToolCallArgsEvent => e.type === EventType.TOOL_CALL_ARGS,
    );
    const endEvent = events.find((e): e is ToolCallEndEvent => e.type === EventType.TOOL_CALL_END);

    expect(startEvent).toBeDefined();
    expect(startEvent?.toolCallId).toBe(TOOL_CALL_ID);
    expect(startEvent?.toolCallName).toBe(TOOL_NAME);

    expect(argsEvent).toBeDefined();
    expect(argsEvent?.toolCallId).toBe(TOOL_CALL_ID);
    expect(JSON.parse(argsEvent?.delta ?? '{}')).toEqual({ inputData: { city: 'Beijing' } });

    expect(endEvent).toBeDefined();
    expect(endEvent?.toolCallId).toBe(TOOL_CALL_ID);
  });

  test('T3: step-start syncs messageId → TEXT_MESSAGE_CHUNK.messageId is server-assigned', async () => {
    const agent = makeLocalAgent([stepStartChunkWithId, textChunk, finishChunk]);
    const adapter = makeAdapter(agent);
    const events = await collectEvents(adapter, makeInput());

    const textEvent = events.find(
      (e): e is TextMessageChunkEvent => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );

    expect(textEvent).toBeDefined();
    expect(textEvent?.messageId).toBe('server-msg-id');
  });

  test('T4: input.state non-empty + getWorkingMemory returns value → STATE_SNAPSHOT before RUN_FINISHED', async () => {
    const agent = makeLocalAgent([textChunk, finishChunk], {
      getWorkingMemory: async (): Promise<string | null> =>
        JSON.stringify({ uiLang: 'zh', extra: 1 }),
    });
    const adapter = makeAdapter(agent);
    const events = await collectEvents(adapter, makeInput({ state: { uiLang: 'zh' } }));

    const snapshotIdx = events.findIndex((e) => e.type === EventType.STATE_SNAPSHOT);
    const finishIdx = events.findIndex((e) => e.type === EventType.RUN_FINISHED);

    expect(snapshotIdx).toBeGreaterThan(-1);
    expect(snapshotIdx).toBeLessThan(finishIdx);

    const snapshotEvent = events.find(
      (e): e is StateSnapshotEvent => e.type === EventType.STATE_SNAPSHOT,
    );
    expect(snapshotEvent?.snapshot).toEqual({ uiLang: 'zh', extra: 1 });
  });

  test('T5: getWorkingMemory returns $schema → STATE_SNAPSHOT is suppressed', async () => {
    const agent = makeLocalAgent([textChunk, finishChunk], {
      getWorkingMemory: async (): Promise<string | null> =>
        JSON.stringify({ $schema: 'http://example.com/schema', uiLang: 'zh' }),
    });
    const adapter = makeAdapter(agent);
    const events = await collectEvents(adapter, makeInput({ state: { uiLang: 'zh' } }));

    expect(events.some((e) => e.type === EventType.STATE_SNAPSHOT)).toBe(false);
  });

  test('T5b: malformed workingMemory metadata falls back to {} and still saves thread', async () => {
    let savedWorkingMemory: string | undefined;
    const agent = makeLocalAgent([textChunk, finishChunk], {
      getThreadById: async () => ({
        ...mockThread,
        metadata: { ...mockThread.metadata, workingMemory: '{bad-json' },
      }),
      saveThread: async (args) => {
        const metadata = args.thread.metadata;
        savedWorkingMemory =
          typeof metadata?.workingMemory === 'string' ? metadata.workingMemory : undefined;
        return args.thread;
      },
    });
    const adapter = makeAdapter(agent);
    const events = await collectEvents(
      adapter,
      makeInput({
        state: {
          uiLang: 'zh',
          messages: ['should-be-ignored'],
        },
      }),
    );

    expect(savedWorkingMemory).toBe(JSON.stringify({ uiLang: 'zh' }));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test('T6: agent.stream throws → subscriber.error, no RUN_FINISHED', async () => {
    const adapter = makeAdapter(makeErroringAgent());
    const { events, error } = await collectEventsWithError(adapter, makeInput());

    expect(error.message).toBe('LLM timeout');
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
  });

  test('T7: error chunk in stream → subscriber.error, no RUN_FINISHED', async () => {
    const agent = makeLocalAgent([textChunk, errorChunk, finishChunk]);
    const adapter = makeAdapter(agent);
    const { events, error } = await collectEventsWithError(adapter, makeInput());

    expect(error).toBeInstanceOf(Error);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(false);
  });

  test('T7b: top-level run error before stream try-block → subscriber.error, no RUN_FINISHED', async () => {
    const adapter = new MastraAgentAdapter(
      {
        agentId: 'test-agent',
        agent: makeLocalAgent([textChunk, finishChunk]),
        resourceId: RESOURCE_ID,
      },
      {
        logger: {
          debug: () => {},
          info: () => {
            throw new Error('logger boom');
          },
          warn: () => {},
          error: () => {},
        },
      },
    );
    const { events, error } = await collectEventsWithError(adapter, makeInput());

    expect(error.message).toBe('logger boom');
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
  });
});

describe('MastraAgentAdapter — run() remote agent', () => {
  test('T8: remote agent full stream → mirrors real recorded sequence (tool-call + text reply)', async () => {
    // 远端代理：无 getMemory 属性，#isLocalAgent 返回 false
    const adapter = new MastraAgentAdapter({
      agentId: 'remote-agent',
      agent: makeRemoteAgent(fullStreamChunks),
      resourceId: RESOURCE_ID,
    });

    const events = await collectEvents(adapter, makeInput());

    // 开始 / 结束
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

    // step-start 同步了 messageId → TEXT_MESSAGE_CHUNK 应携带服务端值
    const textEvent = events.find(
      (e): e is TextMessageChunkEvent => e.type === EventType.TEXT_MESSAGE_CHUNK,
    );
    expect(textEvent?.messageId).toBe('server-msg-id');

    // tool-call 三连事件
    const startEvent = events.find(
      (e): e is ToolCallStartEvent => e.type === EventType.TOOL_CALL_START,
    );
    expect(startEvent?.toolCallId).toBe(TOOL_CALL_ID);
    expect(startEvent?.toolCallName).toBe(TOOL_NAME);
    expect(events.some((e) => e.type === EventType.TOOL_CALL_ARGS)).toBe(true);
    expect(events.some((e) => e.type === EventType.TOOL_CALL_END)).toBe(true);

    // tool-result → TOOL_CALL_RESULT（工作流执行结果回传）
    const resultEvent = events.find(
      (e): e is ToolCallResultEvent => e.type === EventType.TOOL_CALL_RESULT,
    );
    expect(resultEvent).toBeDefined();
    expect(resultEvent?.toolCallId).toBe(TOOL_CALL_ID);
    expect(JSON.parse(resultEvent?.content ?? '{}')).toMatchObject({ condition: 'Sunny' });
  });
});

describe('MastraAgentAdapter — clone()', () => {
  test('T9: clone returns new instance, same agentId, different reference', () => {
    const agent = makeLocalAgent([]);
    const adapter = makeAdapter(agent);
    const cloned = adapter.clone();

    expect(cloned).not.toBe(adapter);
    expect(cloned).toBeInstanceOf(MastraAgentAdapter);
    // 两个实例共享相同的 agentId
    expect((cloned as { agentId?: string }).agentId).toBe(
      (adapter as { agentId?: string }).agentId,
    );
  });
});

describe('MastraAgentAdapter — static factories', () => {
  test('T10: getLocalAgent with unknown agentId → throws Error("Agent xxx not found")', () => {
    const mastra = {
      getAgent: () => undefined,
      listAgents: () => ({}),
    } as unknown as MastraLike;

    expect(() =>
      MastraAgentAdapter.getLocalAgent({ mastra, agentId: 'ghost', resourceId: RESOURCE_ID }),
    ).toThrow('Agent ghost not found');
  });

  test('T11: getLocalAgents → each agent has its own adapter instance', () => {
    const agentA = makeLocalAgent([]);
    const agentB = makeLocalAgent([]);

    const mastra = {
      getAgent: () => undefined,
      listAgents: () => ({ agentA, agentB }),
    } as unknown as MastraLike;

    const result = MastraAgentAdapter.getLocalAgents({ mastra, resourceId: RESOURCE_ID });

    expect(Object.keys(result)).toContain('agentA');
    expect(Object.keys(result)).toContain('agentB');
    expect(result.agentA).not.toBe(result.agentB);
    expect(result.agentA).toBeInstanceOf(MastraAgentAdapter);
    expect(result.agentB).toBeInstanceOf(MastraAgentAdapter);
  });
});

describe('MastraAgentAdapter — deprecated aliases', () => {
  test('T12: MastraAgent / MastraAgentConfig / MastraAgentOptions remain backward compatible', () => {
    const agent = makeLocalAgent([]);
    const config: MastraAgentConfig = {
      agentId: 'legacy-agent',
      agent,
      resourceId: RESOURCE_ID,
    };
    const options: MastraAgentOptions = {};

    const legacyAdapter = new MastraAgent(config, options);

    expect(legacyAdapter).toBeInstanceOf(MastraAgentAdapter);
  });
});
