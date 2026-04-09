import { EventType } from "@ag-ui/client";
import type {
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
} from "@ag-ui/client";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
} from "./helpers";

describe("Mastra reasoning support", () => {
  const reasoningChunks = [
    { type: "reasoning-delta", payload: { text: "Let me think" } },
    { type: "reasoning-delta", payload: { text: " about this" } },
    { type: "text-delta", payload: { text: "Here is my answer" } },
    { type: "finish", payload: { finishReason: "stop" } },
  ];

  describe("local agent", () => {
    it("emits proper AG-UI event sequence for reasoning chunks", async () => {
      const agent = makeLocalMastraAgent({ streamChunks: reasoningChunks });
      const events = await collectEvents(agent, makeInput());

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        EventType.RUN_STARTED,
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        EventType.TEXT_MESSAGE_CHUNK,
        EventType.RUN_FINISHED,
      ]);
    });

    it("uses consistent messageId within a reasoning block", async () => {
      const agent = makeLocalMastraAgent({ streamChunks: reasoningChunks });
      const events = await collectEvents(agent, makeInput());

      const reasoningEvents = events.filter((e) =>
        [
          EventType.REASONING_START,
          EventType.REASONING_MESSAGE_START,
          EventType.REASONING_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_END,
          EventType.REASONING_END,
        ].includes(e.type as EventType),
      );

      const messageIds = reasoningEvents.map((e) => (e as any).messageId);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(1);
      expect(messageIds[0]).toBeTruthy();
    });

    it("emits correct reasoning content deltas", async () => {
      const agent = makeLocalMastraAgent({ streamChunks: reasoningChunks });
      const events = await collectEvents(agent, makeInput());

      const contentEvents = events.filter(
        (e) => e.type === EventType.REASONING_MESSAGE_CONTENT,
      ) as ReasoningMessageContentEvent[];

      expect(contentEvents).toHaveLength(2);
      expect(contentEvents[0].delta).toBe("Let me think");
      expect(contentEvents[1].delta).toBe(" about this");
    });

    it("does not emit reasoning events when model produces no reasoning", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "text-delta", payload: { text: "Just a normal response" } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      const reasoningEvents = events.filter((e) =>
        [
          EventType.REASONING_START,
          EventType.REASONING_MESSAGE_START,
          EventType.REASONING_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_END,
          EventType.REASONING_END,
        ].includes(e.type as EventType),
      );

      expect(reasoningEvents).toHaveLength(0);
    });

    it("closes reasoning block when tool-call arrives", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "reasoning-delta", payload: { text: "I should use a tool" } },
          {
            type: "tool-call",
            payload: { toolCallId: "tc-1", toolName: "get_data", args: {} },
          },
          {
            type: "tool-result",
            payload: { toolCallId: "tc-1", result: "data" },
          },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      const types = events.map((e) => e.type);

      // Reasoning should be closed before tool call events
      const reasoningEndIdx = types.indexOf(EventType.REASONING_END);
      const toolCallStartIdx = types.indexOf(EventType.TOOL_CALL_START);
      expect(reasoningEndIdx).toBeGreaterThan(-1);
      expect(toolCallStartIdx).toBeGreaterThan(-1);
      expect(reasoningEndIdx).toBeLessThan(toolCallStartIdx);
    });

    it("closes reasoning block on finish when no text follows", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "reasoning-delta", payload: { text: "thinking..." } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      const types = events.map((e) => e.type);
      expect(types).toContain(EventType.REASONING_MESSAGE_END);
      expect(types).toContain(EventType.REASONING_END);

      // Reasoning end should happen before RUN_FINISHED
      const reasoningEndIdx = types.indexOf(EventType.REASONING_END);
      const runFinishedIdx = types.indexOf(EventType.RUN_FINISHED);
      expect(reasoningEndIdx).toBeLessThan(runFinishedIdx);
    });

    it("handles multiple reasoning blocks with distinct messageIds", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "reasoning-delta", payload: { text: "Step 1 thinking" } },
          { type: "text-delta", payload: { text: "Partial answer." } },
          { type: "reasoning-delta", payload: { text: "Step 2 thinking" } },
          { type: "text-delta", payload: { text: "Final answer." } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });

      const events = await collectEvents(
        agent,
        makeInput({
          messages: [{ id: "1", role: "user", content: "Think in steps" }],
        }),
      );

      // Should have two distinct reasoning blocks
      const reasoningStarts = events.filter(
        (e) => e.type === EventType.REASONING_START,
      );
      const reasoningEnds = events.filter(
        (e) => e.type === EventType.REASONING_END,
      );
      expect(reasoningStarts).toHaveLength(2);
      expect(reasoningEnds).toHaveLength(2);

      // Each block should have a different messageId
      const startIds = reasoningStarts.map((e: any) => e.messageId);
      expect(startIds[0]).not.toBe(startIds[1]);
    });

    it("sets role to reasoning on REASONING_MESSAGE_START", async () => {
      const agent = makeLocalMastraAgent({ streamChunks: reasoningChunks });
      const events = await collectEvents(agent, makeInput());

      const msgStart = events.find(
        (e) => e.type === EventType.REASONING_MESSAGE_START,
      ) as ReasoningMessageStartEvent;

      expect(msgStart).toBeDefined();
      expect(msgStart.role).toBe("reasoning");
    });

    it("emits REASONING events for start/end without content (o3-style)", async () => {
      const agent = makeLocalMastraAgent({
        streamChunks: [
          { type: "reasoning-start", payload: { id: "r-1" } },
          { type: "reasoning-end", payload: { id: "r-1" } },
          { type: "text-delta", payload: { text: "The answer is 42." } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });

      const events = await collectEvents(agent, makeInput());
      const types = events.map((e) => e.type);

      expect(types).toContain(EventType.REASONING_START);
      expect(types).toContain(EventType.REASONING_MESSAGE_START);
      expect(types).toContain(EventType.REASONING_MESSAGE_END);
      expect(types).toContain(EventType.REASONING_END);

      // No REASONING_MESSAGE_CONTENT since there were no reasoning-delta chunks
      const contentEvents = events.filter(
        (e) => e.type === EventType.REASONING_MESSAGE_CONTENT,
      );
      expect(contentEvents).toHaveLength(0);

      // Reasoning should be closed before text
      const reasoningEndIdx = types.indexOf(EventType.REASONING_END);
      const textIdx = types.indexOf(EventType.TEXT_MESSAGE_CHUNK);
      expect(reasoningEndIdx).toBeLessThan(textIdx);
    });
  });

  describe("remote agent", () => {
    it("emits proper AG-UI event sequence for reasoning chunks", async () => {
      const agent = makeRemoteMastraAgent({ streamChunks: reasoningChunks });
      const events = await collectEvents(agent, makeInput());

      const types = events.map((e) => e.type);
      expect(types).toEqual([
        EventType.RUN_STARTED,
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_CONTENT,
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        EventType.TEXT_MESSAGE_CHUNK,
        EventType.RUN_FINISHED,
      ]);
    });

    it("uses consistent messageId within a reasoning block", async () => {
      const agent = makeRemoteMastraAgent({ streamChunks: reasoningChunks });
      const events = await collectEvents(agent, makeInput());

      const reasoningEvents = events.filter((e) =>
        [
          EventType.REASONING_START,
          EventType.REASONING_MESSAGE_START,
          EventType.REASONING_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_END,
          EventType.REASONING_END,
        ].includes(e.type as EventType),
      );

      const messageIds = reasoningEvents.map((e) => (e as any).messageId);
      const uniqueIds = new Set(messageIds);
      expect(uniqueIds.size).toBe(1);
      expect(messageIds[0]).toBeTruthy();
    });

    it("emits correct reasoning content deltas", async () => {
      const agent = makeRemoteMastraAgent({ streamChunks: reasoningChunks });
      const events = await collectEvents(agent, makeInput());

      const contentEvents = events.filter(
        (e) => e.type === EventType.REASONING_MESSAGE_CONTENT,
      ) as ReasoningMessageContentEvent[];

      expect(contentEvents).toHaveLength(2);
      expect(contentEvents[0].delta).toBe("Let me think");
      expect(contentEvents[1].delta).toBe(" about this");
    });

    it("does not emit reasoning events when model produces no reasoning", async () => {
      const agent = makeRemoteMastraAgent({
        streamChunks: [
          { type: "text-delta", payload: { text: "Just a normal response" } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      const reasoningEvents = events.filter((e) =>
        [
          EventType.REASONING_START,
          EventType.REASONING_MESSAGE_START,
          EventType.REASONING_MESSAGE_CONTENT,
          EventType.REASONING_MESSAGE_END,
          EventType.REASONING_END,
        ].includes(e.type as EventType),
      );

      expect(reasoningEvents).toHaveLength(0);
    });

    it("closes reasoning block when tool-call arrives", async () => {
      const agent = makeRemoteMastraAgent({
        streamChunks: [
          { type: "reasoning-delta", payload: { text: "I should use a tool" } },
          {
            type: "tool-call",
            payload: { toolCallId: "tc-1", toolName: "get_data", args: {} },
          },
          {
            type: "tool-result",
            payload: { toolCallId: "tc-1", result: "data" },
          },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      const types = events.map((e) => e.type);
      const reasoningEndIdx = types.indexOf(EventType.REASONING_END);
      const toolCallStartIdx = types.indexOf(EventType.TOOL_CALL_START);
      expect(reasoningEndIdx).toBeGreaterThan(-1);
      expect(toolCallStartIdx).toBeGreaterThan(-1);
      expect(reasoningEndIdx).toBeLessThan(toolCallStartIdx);
    });

    it("closes reasoning block on finish when no text follows", async () => {
      const agent = makeRemoteMastraAgent({
        streamChunks: [
          { type: "reasoning-delta", payload: { text: "thinking..." } },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());

      const types = events.map((e) => e.type);
      expect(types).toContain(EventType.REASONING_MESSAGE_END);
      expect(types).toContain(EventType.REASONING_END);

      const reasoningEndIdx = types.indexOf(EventType.REASONING_END);
      const runFinishedIdx = types.indexOf(EventType.RUN_FINISHED);
      expect(reasoningEndIdx).toBeLessThan(runFinishedIdx);
    });
  });
});
