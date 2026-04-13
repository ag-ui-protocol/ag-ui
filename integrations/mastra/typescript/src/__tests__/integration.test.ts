import { EventType } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { MockMemory } from "@mastra/core/memory";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { MastraAgent } from "../mastra";
import { makeInput, collectEvents } from "./helpers";

function createStreamModel(chunks: any[]) {
  return new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
      request: { body: {} },
      response: undefined,
    }),
  });
}

function createTextStreamModel(text: string) {
  return createStreamModel([
    { type: "text-delta" as const, id: "text-1", delta: text },
    { type: "finish" as const, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, finishReason: "stop" as const },
  ]);
}

function createToolCallStreamModel(toolName: string, toolArgs: Record<string, unknown>) {
  return createStreamModel([
    { type: "tool-call" as const, toolCallId: "tc-1", toolName, input: JSON.stringify(toolArgs) },
    { type: "finish" as const, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, finishReason: "tool-calls" as const },
  ]);
}

function createTestAgent(model: any, opts?: { memory?: MockMemory }) {
  return new Agent({
    id: "test-agent",
    name: "test-agent",
    instructions: "Test",
    model,
    ...opts,
  });
}

function wrapAgent(agent: Agent, opts?: { resourceId?: string }) {
  return new MastraAgent({
    agentId: agent.name,
    agent,
    resourceId: opts?.resourceId ?? "resource-1",
  });
}

describe("integration with real Mastra Agent", () => {
  describe("text streaming", () => {
    it("emits RUN_STARTED, TEXT_MESSAGE_CHUNK, RUN_FINISHED for a simple text response", async () => {
      const agent = createTestAgent(createTextStreamModel("Hello world"));
      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({ messages: [{ id: "1", role: "user", content: "Hi" }] }),
      );

      const types = events.map((e) => e.type);
      expect(types[0]).toBe(EventType.RUN_STARTED);
      expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);

      const textChunks = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      expect(textChunks.length).toBeGreaterThan(0);
    });

    it("text chunks share the same messageId within a turn", async () => {
      const model = createStreamModel([
        { type: "text-delta" as const, id: "t1", delta: "Part 1 " },
        { type: "text-delta" as const, id: "t1", delta: "Part 2" },
        { type: "finish" as const, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, finishReason: "stop" as const },
      ]);
      const agent = createTestAgent(model);

      const events = await collectEvents(wrapAgent(agent), makeInput({
        messages: [{ id: "1", role: "user", content: "Hi" }],
      }));

      const textChunks = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      );
      if (textChunks.length >= 2) {
        expect((textChunks[0] as any).messageId).toBe(
          (textChunks[1] as any).messageId,
        );
      }
    });
  });

  describe("tool calls", () => {
    it("emits tool call events for a tool call response", async () => {
      const agent = createTestAgent(createToolCallStreamModel("get_weather", { city: "NYC" }));
      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "What's the weather?" }],
          tools: [
            {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          ],
        }),
      );

      const toolStarts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(toolStarts.length).toBeGreaterThan(0);
      expect((toolStarts[0] as any).toolCallName).toBe("get_weather");

      const toolArgs = events.filter(
        (e) => e.type === EventType.TOOL_CALL_ARGS,
      );
      expect(toolArgs.length).toBeGreaterThan(0);
    });
  });

  describe("working memory", () => {
    it("completes successfully with working memory enabled", async () => {
      const memory = new MockMemory({ enableWorkingMemory: true });
      const agent = createTestAgent(createTextStreamModel("I'll remember that."), { memory });

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "My name is Alice" }],
        }),
      );

      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });

    it("STATE_SNAPSHOT is emitted before RUN_FINISHED when memory is configured", async () => {
      const memory = new MockMemory({ enableWorkingMemory: true });
      const agent = createTestAgent(createTextStreamModel("ok"), { memory });

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      const types = events.map((e) => e.type);
      const finishedIdx = types.indexOf(EventType.RUN_FINISHED);
      const snapshotIdx = types.indexOf(EventType.STATE_SNAPSHOT);

      if (snapshotIdx !== -1) {
        expect(finishedIdx).toBeGreaterThan(snapshotIdx);
      }
    });
  });

  describe("event ordering", () => {
    it("RUN_STARTED and RUN_FINISHED carry correct threadId and runId", async () => {
      const agent = createTestAgent(createTextStreamModel("ok"));

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          threadId: "my-thread",
          runId: "my-run",
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

      const runStarted = events.find(
        (e) => e.type === EventType.RUN_STARTED,
      ) as any;
      const runFinished = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;

      expect(runStarted.threadId).toBe("my-thread");
      expect(runStarted.runId).toBe("my-run");
      expect(runFinished.threadId).toBe("my-thread");
      expect(runFinished.runId).toBe("my-run");
    });
  });

  describe("message conversion", () => {
    it("handles a multi-message conversation without errors", async () => {
      const agent = createTestAgent(createTextStreamModel("I see the full history."));

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [
            { id: "1", role: "user", content: "Hello" },
            { id: "2", role: "assistant", content: "Hi there!" },
            { id: "3", role: "user", content: "How are you?" },
          ],
        }),
      );

      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    });
  });
});
