import { EventType } from "@ag-ui/client";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { MockMemory } from "@mastra/core/memory";
import { InMemoryStore } from "@mastra/core/storage";
import { createTool } from "@mastra/core/tools";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { z } from "zod";
import { MastraAgent } from "../mastra";
import { makeInput, collectEvents } from "./helpers";

function createStreamModel(
  chunks: any[],
  onPrompt?: (prompt: unknown) => void,
) {
  return new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }: { prompt: unknown }) => {
      onPrompt?.(prompt);
      return {
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
      };
    },
  });
}

function createTextStreamModel(text: string) {
  return createStreamModel([
    { type: "text-delta" as const, id: "text-1", delta: text },
    {
      type: "finish" as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop" as const,
    },
  ]);
}

// Fall-back path: an LLM that emits ONLY the final tool-call (no incremental
// tool-input-* chunks). Mirrors older @mastra/core in the supported 1.0.x floor.
function createToolCallStreamModel(
  toolName: string,
  toolArgs: Record<string, unknown>,
) {
  return createStreamModel([
    {
      type: "tool-call" as const,
      toolCallId: "tc-1",
      toolName,
      input: JSON.stringify(toolArgs),
    },
    {
      type: "finish" as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "tool-calls" as const,
    },
  ]);
}

// Streaming path: an LLM that streams the tool-call args as incremental
// tool-input-delta chunks (Mastra maps these to tool-call-delta chunks). The
// `argChunks` are raw JSON-text fragments that concatenate to a valid args JSON.
function createStreamingToolCallModel(
  toolName: string,
  toolCallId: string,
  argChunks: string[],
) {
  return createStreamModel([
    { type: "tool-input-start" as const, id: toolCallId, toolName },
    ...argChunks.map((delta) => ({
      type: "tool-input-delta" as const,
      id: toolCallId,
      delta,
    })),
    { type: "tool-input-end" as const, id: toolCallId },
    {
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: argChunks.join(""),
    },
    {
      type: "finish" as const,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "tool-calls" as const,
    },
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
  it("forwards developer instructions as system messages on successive runs", async () => {
    const prompts: unknown[] = [];
    const model = createStreamModel(
      [
        { type: "text-delta", id: "t1", delta: "Hallo" },
        {
          type: "finish",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "stop",
        },
      ],
      (prompt) => prompts.push(prompt),
    );
    const agent = wrapAgent(createTestAgent(model));
    const developer = {
      id: "d1",
      role: "developer" as const,
      content: "Answer in German.",
    };

    for (const messages of [
      [developer],
      [developer, { id: "u2", role: "user" as const, content: "Hi" }],
    ]) {
      const events = await collectEvents(agent, makeInput({ messages }));
      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
        false,
      );
      expect(
        events.some((event) => event.type === EventType.TEXT_MESSAGE_CHUNK),
      ).toBe(true);
    }

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toEqual(
        expect.arrayContaining([
          { role: "system", content: "Test" },
          { role: "system", content: developer.content },
        ]),
      );
    }
  });

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
        {
          type: "finish" as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          finishReason: "stop" as const,
        },
      ]);
      const agent = createTestAgent(model);

      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "Hi" }],
        }),
      );

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
    const weatherTools = [
      {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ];

    it("streams tool-call args incrementally when the model emits arg deltas", async () => {
      // Two arg-text fragments that concatenate to {"city":"NYC"}
      const argChunks = ['{"city":', '"NYC"}'];
      const agent = createTestAgent(
        createStreamingToolCallModel("get_weather", "tc-1", argChunks),
      );
      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "What's the weather?" }],
          tools: weatherTools,
        }),
      );

      const toolStarts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(toolStarts).toHaveLength(1);
      expect((toolStarts[0] as any).toolCallName).toBe("get_weather");
      expect((toolStarts[0] as any).toolCallId).toBe("tc-1");

      // The whole point: args arrive as MULTIPLE deltas, not a single blob.
      const toolArgs = events.filter(
        (e) => e.type === EventType.TOOL_CALL_ARGS,
      );
      expect(toolArgs.length).toBe(argChunks.length);
      expect(toolArgs.every((e) => (e as any).toolCallId === "tc-1")).toBe(
        true,
      );
      // Concatenated deltas reconstruct the full args JSON.
      const assembled = toolArgs.map((e) => (e as any).delta).join("");
      expect(assembled).toBe('{"city":"NYC"}');
      expect(JSON.parse(assembled)).toEqual({ city: "NYC" });

      // Exactly one START and one END bracket the streamed args.
      const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END);
      expect(toolEnds).toHaveLength(1);

      // Ordering: START before all ARGS, all ARGS before END.
      const types = events.map((e) => e.type);
      const startIdx = types.indexOf(EventType.TOOL_CALL_START);
      const endIdx = types.indexOf(EventType.TOOL_CALL_END);
      const argIdxs = types
        .map((t, i) => (t === EventType.TOOL_CALL_ARGS ? i : -1))
        .filter((i) => i !== -1);
      expect(startIdx).toBeLessThan(Math.min(...argIdxs));
      expect(Math.max(...argIdxs)).toBeLessThan(endIdx);
    });

    it("falls back to a single TOOL_CALL_ARGS when the model emits no arg deltas", async () => {
      // Floor / backwards-compat: @mastra/core that emits only the final
      // tool-call chunk (no tool-call-delta) must still produce a clean
      // START + single full-args ARGS + END.
      const agent = createTestAgent(
        createToolCallStreamModel("get_weather", { city: "NYC" }),
      );
      const events = await collectEvents(
        wrapAgent(agent),
        makeInput({
          messages: [{ id: "1", role: "user", content: "What's the weather?" }],
          tools: weatherTools,
        }),
      );

      const toolStarts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      );
      expect(toolStarts).toHaveLength(1);
      expect((toolStarts[0] as any).toolCallName).toBe("get_weather");

      const toolArgs = events.filter(
        (e) => e.type === EventType.TOOL_CALL_ARGS,
      );
      // Exactly one delta carrying the complete args.
      expect(toolArgs).toHaveLength(1);
      expect(JSON.parse((toolArgs[0] as any).delta)).toEqual({ city: "NYC" });

      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(1);
    });
  });

  describe("working memory", () => {
    it("completes successfully with working memory enabled", async () => {
      const memory = new MockMemory({ enableWorkingMemory: true });
      const agent = createTestAgent(
        createTextStreamModel("I'll remember that."),
        { memory },
      );

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

  describe("attachment filenames in memory", () => {
    const attachments = [
      { type: "image", mimeType: "image/png", filename: "kitchen photo.png" },
      { type: "audio", mimeType: "audio/mpeg", filename: "voice memo.mp3" },
      { type: "video", mimeType: "video/mp4", filename: "walkthrough.mp4" },
      {
        type: "document",
        mimeType: "application/pdf",
        filename: "floor plan.pdf",
      },
    ] as const;
    const dataUrl = (mimeType: string) =>
      `data:${mimeType};base64,QVRUQUNITUVOVA==`;

    it("stores each attachment once with its bytes, MIME type and original filename", async () => {
      const memory = new MockMemory();
      const agent = wrapAgent(
        createTestAgent(createTextStreamModel("Got them."), { memory }),
      );
      const threadId = "thread-attachments";
      const firstUser = {
        id: "user-1",
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Here are my files" },
          ...attachments.map(({ type, mimeType, filename }) => ({
            type,
            source: {
              type: "data" as const,
              value: "QVRUQUNITUVOVA==",
              mimeType,
            },
            metadata: { filename },
          })),
        ],
      };

      const firstRun = await collectEvents(
        agent,
        makeInput({ threadId, messages: [firstUser] as any }),
      );
      expect(firstRun.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
      const assistantId = (
        firstRun.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK) as any
      ).messageId;

      const secondRun = await collectEvents(
        agent,
        makeInput({
          threadId,
          messages: [
            firstUser,
            { id: assistantId, role: "assistant", content: "Got them." },
            { id: "user-2", role: "user", content: "Which one is the PDF?" },
          ] as any,
        }),
      );
      expect(secondRun.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);

      const { messages } = await memory.recall({
        threadId,
        resourceId: "resource-1",
        perPage: false,
      });
      const storedFirstUser = messages.filter((m) =>
        JSON.stringify(m.content).includes("Here are my files"),
      );
      expect(storedFirstUser).toHaveLength(1);

      const storedJson = JSON.stringify(storedFirstUser[0].content);
      const fileParts = storedFirstUser[0].content.parts.filter(
        (part: any) => part.type === "file",
      );
      expect(fileParts).toEqual(
        attachments.map(({ mimeType, filename }) =>
          expect.objectContaining({
            type: "file",
            data: dataUrl(mimeType),
            mimeType,
            filename,
          }),
        ),
      );
      for (const { filename } of attachments) {
        expect(storedJson.split(filename)).toHaveLength(2);
      }

      const { threads } = await memory.listThreads({ perPage: false });
      expect(threads.map((t) => t.id)).toContain(threadId);
      for (const thread of threads.filter((t) => t.id !== threadId)) {
        const other = await memory.recall({
          threadId: thread.id,
          resourceId: thread.resourceId,
          perPage: false,
        });
        const otherJson = JSON.stringify(other.messages);
        for (const { filename } of attachments) {
          expect(otherJson).not.toContain(filename);
        }
      }
    });
  });

  describe("message conversion", () => {
    it("handles a multi-message conversation without errors", async () => {
      const agent = createTestAgent(
        createTextStreamModel("I see the full history."),
      );

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

  describe("suspend and resume", () => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

    // First model call asks for the tool; any later call answers in text.
    function toolThenTextModel() {
      let calls = 0;
      const model = new MastraLanguageModelV2Mock({
        doStream: async () => {
          calls++;
          const chunks =
            calls === 1
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "tc-1",
                    toolName: "approve_expense",
                    input: JSON.stringify({ amount: 250 }),
                  },
                  { type: "finish", usage, finishReason: "tool-calls" },
                ]
              : [
                  { type: "text-delta", id: "t1", delta: "Filed." },
                  { type: "finish", usage, finishReason: "stop" },
                ];
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
              },
            }),
            request: { body: {} },
            response: undefined,
          };
        },
      });
      return { model, modelCalls: () => calls };
    }

    function suspendingAgent() {
      const { model, modelCalls } = toolThenTextModel();
      const executions: unknown[] = [];
      const approveExpense = createTool({
        id: "approve_expense",
        description: "Files an expense once a human approves it",
        inputSchema: z.object({ amount: z.number() }),
        suspendSchema: z.object({ message: z.string() }),
        execute: async (_input: any, ctx: any) => {
          executions.push(ctx?.agent?.resumeData);
          if (executions.length === 1) {
            return ctx.agent.suspend({ message: "Approve this expense?" });
          }
          return { filed: true };
        },
      });
      const agent = new Agent({
        id: "expense-agent",
        name: "expense-agent",
        instructions: "File expenses.",
        model: model as any,
        tools: { approve_expense: approveExpense },
        memory: new MockMemory() as any,
      });
      const mastra = new Mastra({
        agents: { expense: agent },
        storage: new InMemoryStore(),
        logger: false,
      });
      const bridge = new MastraAgent({
        agentId: "expense-agent",
        agent: mastra.getAgent("expense"),
        resourceId: "resource-1",
      });
      // The id Mastra stores the suspended turn's assistant message under.
      const storedAssistantId = async () => {
        const memory = await mastra.getAgent("expense").getMemory();
        const { messages } = await memory!.recall({
          threadId: "thread-1",
          resourceId: "resource-1",
        });
        return messages.find((m: any) => m.role === "assistant")?.id;
      };
      return { bridge, executions, modelCalls, storedAssistantId };
    }

    async function suspendThenResume(history: (assistantId: string) => any[]) {
      const { bridge, storedAssistantId } = suspendingAgent();
      const user = { id: "u1", role: "user", content: "File my dinner" };
      const first = await collectEvents(
        bridge,
        makeInput({ runId: "run-1", messages: [user] as any }),
      );
      const finished = first.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      const assistantId = await storedAssistantId();
      expect(assistantId).toEqual(expect.any(String));
      const second = await collectEvents(
        bridge,
        makeInput({
          runId: "run-2",
          messages: [user, ...history(assistantId!)] as any,
          resume: [
            {
              interruptId: finished.outcome.interrupts[0].id,
              status: "resolved",
            },
          ],
        }),
      );
      return { events: second, assistantId: assistantId! };
    }

    it("resumes the suspended tool from a resolved entry with no payload", async () => {
      const { bridge, executions, modelCalls } = suspendingAgent();

      const first = await collectEvents(
        bridge,
        makeInput({
          runId: "run-1",
          messages: [{ id: "u1", role: "user", content: "File my dinner" }],
        }),
      );
      const finished = first.find(
        (e) => e.type === EventType.RUN_FINISHED,
      ) as any;
      expect(finished.outcome.type).toBe("interrupt");
      const [interrupt] = finished.outcome.interrupts;
      expect(interrupt.toolCallId).toBe("tc-1");
      expect(interrupt.message).toBe("Approve this expense?");

      const second = await collectEvents(
        bridge,
        makeInput({
          runId: "run-2",
          resume: [{ interruptId: interrupt.id, status: "resolved" }],
        }),
      );

      // The suspended tool ran again with no resume data and returned, and the
      // model was only called once more, to answer after the tool result. A
      // fresh run would have asked the model first and produced no tool result.
      expect(executions).toEqual([undefined, undefined]);
      const results = second.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      ) as any[];
      expect(results).toHaveLength(1);
      expect(results[0].toolCallId).toBe("tc-1");
      expect(JSON.parse(results[0].content)).toEqual({ filed: true });
      expect(modelCalls()).toBe(2);
      expect(second.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
      expect(second[second.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("opens the resumed call under the id Mastra stores it under", async () => {
      const { events, assistantId } = await suspendThenResume(() => []);

      const starts = events.filter(
        (e) => e.type === EventType.TOOL_CALL_START,
      ) as any[];
      const result = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      ) as any;
      const text = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      ) as any[];
      expect(starts).toHaveLength(1);
      expect(starts[0].toolCallId).toBe("tc-1");
      expect(starts[0].parentMessageId).toBe(assistantId);
      expect(events.indexOf(result)).toBeGreaterThan(events.indexOf(starts[0]));
      expect(text.map((t) => t.messageId)).toEqual([
        `${assistantId}-agui-text`,
      ]);
      expect(events.indexOf(text[0])).toBeGreaterThan(events.indexOf(result));
    });

    it("does not re-open a resumed call the client already holds", async () => {
      const { events, assistantId } = await suspendThenResume((id) => [
        {
          id,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              type: "function",
              function: {
                name: "approve_expense",
                arguments: JSON.stringify({ amount: 250 }),
              },
            },
          ],
        },
      ]);

      const types = events.map((e) => e.type);
      expect(types).not.toContain(EventType.TOOL_CALL_START);
      expect(types).not.toContain(EventType.TOOL_CALL_ARGS);
      const result = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      ) as any;
      expect(result.toolCallId).toBe("tc-1");
      const text = events.filter(
        (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
      ) as any[];
      expect(text.map((t) => t.messageId)).toEqual([
        `${assistantId}-agui-text`,
      ]);
      expect(events.indexOf(text[0])).toBeGreaterThan(events.indexOf(result));
    });
  });
});
