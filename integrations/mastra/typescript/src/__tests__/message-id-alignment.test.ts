import { EventType } from "@ag-ui/client";
import type { AssistantMessage, BaseEvent, Message } from "@ag-ui/client";
import { MastraAgent } from "../mastra";
import {
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
  makeInput,
  collectEvents,
  collectRunError,
  runThroughClient,
  FakeMemory,
  FakeLocalAgent,
  FakeRemoteAgent,
} from "./helpers";

/**
 * Regression tests for OSS-105: the bridge must stream the assistant message
 * under the id Mastra announces on the start / step-start chunk (the id Mastra
 * persists), not a freshly minted randomUUID. Otherwise the id the client sees
 * differs from the stored id, and re-sent history on the next turn fails to
 * dedupe, duplicating the assistant message in storage.
 */
describe("assistant message id alignment", () => {
  it("adopts the start chunk's messageId for streamed text", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-msg-1" } },
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const chunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    expect(chunk).toBeDefined();
    expect(chunk.messageId).toBe("mastra-msg-1");
  });

  it("adopts the step-start messageId and applies it to a tool call's parentMessageId", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: "mastra-msg-2" } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "call-1",
            toolName: "get_weather",
            args: { city: "NYC" },
          },
        },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const start = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;

    expect(start).toBeDefined();
    expect(start.parentMessageId).toBe("mastra-msg-2");
  });

  it("uses a new messageId per step when step-start announces a new id", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-msg-A" } },
        { type: "text-delta", payload: { text: "first" } },
        { type: "step-finish", payload: {} },
        { type: "step-start", payload: { messageId: "mastra-msg-B" } },
        { type: "text-delta", payload: { text: "second" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const ids = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e: any) => e.messageId);

    expect(ids).toContain("mastra-msg-A");
    expect(ids).toContain("mastra-msg-B");
  });

  it("falls back to a generated id when no start messageId is provided", async () => {
    // Remote/older streams may omit the start messageId. The bridge must still
    // emit a valid, stable messageId so the stream is well-formed.
    const agent = makeRemoteMastraAgent({
      streamChunks: [
        { type: "text-delta", payload: { text: "Hello" } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const chunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    expect(chunk).toBeDefined();
    expect(typeof chunk.messageId).toBe("string");
    expect(chunk.messageId.length).toBeGreaterThan(0);
  });
});

/**
 * Regression tests for the message-ORDERING bug: Mastra assigns ONE messageId
 * to an entire assistant turn and re-announces it on the next step-start, so a
 * backend tool call (step 1) and the model's trailing narration (step 2) land
 * under the same id. Under one AG-UI messageId CopilotKit draws text BEFORE tool
 * calls, so the narration renders ABOVE the tool card even though it streamed
 * last. The bridge must split trailing text that lands on a tool-call id into a
 * SEPARATE, deterministic continuation message so it renders card -> result ->
 * text — while keeping that split id dedup-able across re-sent history.
 */
describe("assistant text ordering vs backend tool calls", () => {
  const TURN_ID = "mastra-turn-1";
  // Keep in sync with MastraAgent.continuationMessageId (private).
  const CONTINUATION_ID = `${TURN_ID}-agui-text`;

  it("splits trailing text onto a distinct continuation id when Mastra reuses the turn id across the tool call", async () => {
    // The exact real-world shape: one messageId re-announced on both step-starts.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: TURN_ID } },
        {
          type: "tool-call",
          payload: {
            toolCallId: "call-1",
            toolName: "get_weather",
            args: { city: "SF" },
          },
        },
        { type: "tool-result", payload: { toolCallId: "call-1", result: { t: 20 } } },
        { type: "step-finish", payload: {} },
        // Mastra re-announces the SAME id for the trailing-text step.
        { type: "step-start", payload: { messageId: TURN_ID } },
        { type: "text-delta", payload: { text: "It is sunny." } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;
    const textChunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    // Tool call keeps the turn id; text splits to the continuation id.
    expect(toolStart.parentMessageId).toBe(TURN_ID);
    expect(textChunk.messageId).toBe(CONTINUATION_ID);
    expect(textChunk.messageId).not.toBe(toolStart.parentMessageId);

    // And it is emitted AFTER the tool call (renders below the card).
    const toolIdx = events.indexOf(toolStart);
    const textIdx = events.indexOf(textChunk);
    expect(textIdx).toBeGreaterThan(toolIdx);
  });

  it("keeps text that PRECEDES a tool call under the base id (renders above the card, correctly)", async () => {
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: TURN_ID } },
        { type: "text-delta", payload: { text: "Let me check the weather." } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-1", toolName: "get_weather", args: {} },
        },
        { type: "tool-result", payload: { toolCallId: "call-1", result: {} } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const toolStart = events.find(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any;
    const textChunk = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CHUNK,
    ) as any;

    // Pre-tool narration legitimately shares the tool call's message id.
    expect(textChunk.messageId).toBe(TURN_ID);
    expect(toolStart.parentMessageId).toBe(TURN_ID);
  });

  it("dedups the split continuation message from re-sent history (no duplicate text next turn)", async () => {
    // Mastra recall reports the turn stored under its base id only. On the next
    // turn CopilotKit re-sends the base assistant message AND the split
    // continuation text; both must be filtered so only the new user turn is
    // forwarded — otherwise the trailing text is re-persisted and duplicated.
    const memory = new FakeMemory();
    memory.recallMessages = [{ id: TURN_ID }];
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-turn-2" } },
        { type: "text-delta", payload: { text: "ok" } },
        { type: "finish", payload: {} },
      ],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: TURN_ID, role: "assistant", content: "" } as any,
          {
            id: CONTINUATION_ID,
            role: "assistant",
            content: "It is sunny.",
          } as any,
          { id: "user-2", role: "user", content: "and tomorrow?" } as any,
        ],
      }),
    );

    const forwarded = JSON.stringify(fake.lastStreamMessages ?? []);
    // The already-stored turn and its continuation text are dropped...
    expect(forwarded).not.toContain("It is sunny.");
    // ...only the new user turn is forwarded.
    expect(forwarded).toContain("and tomorrow?");
  });
});

/**
 * Regression tests for #2380: a turn that alternates text -> tool -> text ->
 * tool -> text produces MORE THAN ONE tool->text boundary. Each boundary must
 * open its OWN continuation message, otherwise every segment after the first
 * tool call reuses one id: the client appends the later deltas onto the message
 * at its original index, so segments run together and render above the tool
 * cards they were written after. The per-segment ids stay DERIVABLE from the
 * stored base id so re-sent history still dedups (see #2054).
 */
describe("assistant text segments across multiple tool calls", () => {
  const TURN_ID = "mastra-turn-multi";
  // Keep in sync with MastraAgent.continuationMessageId (private).
  const SEGMENT_2_ID = `${TURN_ID}-agui-text`;
  const SEGMENT_3_ID = `${TURN_ID}-agui-text-2`;

  const alternatingChunks = [
    { type: "step-start", payload: { messageId: TURN_ID } },
    { type: "text-delta", payload: { text: "First" } },
    { type: "text-delta", payload: { text: " line." } },
    {
      type: "tool-call",
      payload: {
        toolCallId: "call-1",
        toolName: "search_apps",
        args: { q: "a" },
      },
    },
    { type: "tool-result", payload: { toolCallId: "call-1", result: {} } },
    { type: "step-finish", payload: {} },
    { type: "step-start", payload: { messageId: TURN_ID } },
    { type: "text-delta", payload: { text: "Second" } },
    { type: "text-delta", payload: { text: " line." } },
    {
      type: "tool-call",
      payload: {
        toolCallId: "call-2",
        toolName: "search_apps",
        args: { q: "b" },
      },
    },
    { type: "tool-result", payload: { toolCallId: "call-2", result: {} } },
    { type: "step-finish", payload: {} },
    { type: "step-start", payload: { messageId: TURN_ID } },
    { type: "text-delta", payload: { text: "Third line." } },
    { type: "finish", payload: {} },
  ];

  it("gives each text segment its own message id", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: alternatingChunks });

    const events = await collectEvents(agent, makeInput());
    const textIds = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e: any) => e.messageId);

    // Three contiguous runs of text -> three distinct ids, and the deltas
    // within a run share one id.
    expect(textIds).toEqual([
      TURN_ID,
      TURN_ID,
      SEGMENT_2_ID,
      SEGMENT_2_ID,
      SEGMENT_3_ID,
    ]);
    expect(new Set(textIds).size).toBe(3);
  });

  it("emits each segment after the tool call it followed", async () => {
    const agent = makeLocalMastraAgent({ streamChunks: alternatingChunks });

    const events = await collectEvents(agent, makeInput());
    // The interleaving as the client sees it: text, card, text, card, text.
    const timeline = events
      .filter(
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CHUNK ||
          e.type === EventType.TOOL_CALL_START,
      )
      .map((e: any) =>
        e.type === EventType.TOOL_CALL_START
          ? `tool:${e.toolCallId}`
          : `text:${e.messageId}`,
      );

    expect(timeline).toEqual([
      `text:${TURN_ID}`,
      `text:${TURN_ID}`,
      "tool:call-1",
      `text:${SEGMENT_2_ID}`,
      `text:${SEGMENT_2_ID}`,
      "tool:call-2",
      `text:${SEGMENT_3_ID}`,
    ]);
  });

  it("does not open a new segment for back-to-back tool calls with no text between", async () => {
    // Parallel/consecutive calls must not burn segment indexes — the text that
    // follows them is still the first continuation.
    const agent = makeLocalMastraAgent({
      streamChunks: [
        { type: "step-start", payload: { messageId: TURN_ID } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-1", toolName: "a", args: {} },
        },
        {
          type: "tool-call",
          payload: { toolCallId: "call-2", toolName: "b", args: {} },
        },
        { type: "tool-result", payload: { toolCallId: "call-1", result: {} } },
        { type: "tool-result", payload: { toolCallId: "call-2", result: {} } },
        { type: "step-finish", payload: {} },
        { type: "step-start", payload: { messageId: TURN_ID } },
        { type: "text-delta", payload: { text: "Done." } },
        { type: "finish", payload: {} },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const textIds = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e: any) => e.messageId);

    expect(textIds).toEqual([SEGMENT_2_ID]);
  });

  it("dedups every segment of a re-sent turn (no duplicate text next turn)", async () => {
    // #2054's contract, extended: Mastra recall reports the turn under its base
    // id only, so EVERY derived segment id must be recognised as already
    // stored. If it is not, the extra segments are re-forwarded and re-persisted
    // on each turn — the O(n^2) thread growth #2054 exists to prevent.
    const memory = new FakeMemory();
    memory.recallMessages = [{ id: TURN_ID }];
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-turn-next" } },
        { type: "text-delta", payload: { text: "ok" } },
        { type: "finish", payload: {} },
      ],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: TURN_ID, role: "assistant", content: "First line." } as any,
          {
            id: SEGMENT_2_ID,
            role: "assistant",
            content: "Second line.",
          } as any,
          {
            id: SEGMENT_3_ID,
            role: "assistant",
            content: "Third line.",
          } as any,
          { id: "user-2", role: "user", content: "and now?" } as any,
        ],
      }),
    );

    const forwarded = JSON.stringify(fake.lastStreamMessages ?? []);
    expect(forwarded).not.toContain("First line.");
    expect(forwarded).not.toContain("Second line.");
    expect(forwarded).not.toContain("Third line.");
    expect(forwarded).toContain("and now?");
  });

  it("does not treat an unrelated message id as a continuation of a stored turn", async () => {
    // The dedupe must key off the STORED base id, not the suffix shape alone,
    // or a genuinely new message could be swallowed.
    const memory = new FakeMemory();
    memory.recallMessages = [{ id: TURN_ID }];
    const fake = new FakeLocalAgent({
      memory,
      streamChunks: [
        { type: "start", payload: { messageId: "mastra-turn-next" } },
        { type: "text-delta", payload: { text: "ok" } },
        { type: "finish", payload: {} },
      ],
    });
    const agent = new MastraAgent({
      agentId: "test-agent",
      agent: fake as any,
      resourceId: "resource-1",
    });

    await collectEvents(
      agent,
      makeInput({
        messages: [
          { id: TURN_ID, role: "assistant", content: "stored" } as any,
          {
            id: "some-other-turn-agui-text-2",
            role: "assistant",
            content: "unrelated segment",
          } as any,
          // A genuinely new turn, so the diff is non-empty and the
          // "never send an empty turn" fallback cannot mask the filter.
          { id: "user-2", role: "user", content: "and now?" } as any,
        ],
      }),
    );

    const forwarded = JSON.stringify(fake.lastStreamMessages ?? []);
    expect(forwarded).toContain("unrelated segment");
  });
});

/**
 * The same segmentation, with output processors on.
 *
 * `useProcessedFinalText: true` buffers `text-delta` chunks and emits the processed text at a
 * finish boundary instead of as it streams. Both halves of the segmentation logic read state at
 * the moment text is emitted, so deferring that call past the tool boundary reads it too late:
 * the first segment picks up a boundary that had not opened when its text arrived, and
 * `textSinceLastToolCall` is still false when the next tool call opens, so two boundaries collapse
 * into one and later segments share an id.
 */
describe("assistant text segmentation with useProcessedFinalText", () => {
  const assistantText = (text: string) => ({
    response: {
      uiMessages: [{ role: "assistant", content: [{ type: "text", text }] }],
    },
  });

  /*
   * The shape that actually bites: Mastra re-announces the same messageId across the step
   * boundary, and the tool call lands before the buffered text is released. Both halves of the
   * segmentation logic read state when text is emitted, and buffering moves that to `step-finish`
   * — after the boundary has been counted. So the first segment picks up a boundary that had not
   * opened when its text arrived, and `textSinceLastToolCall` is still false when the next tool
   * call opens, so two boundaries collapse into one and later segments share an id.
   */
  it("gives each text segment its own id across two tool boundaries", async () => {
    const agent = makeLocalMastraAgent({
      useProcessedFinalText: true,
      streamChunks: [
        { type: "start", payload: { messageId: "base" } },
        { type: "text-delta", payload: { text: "first" } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-1", toolName: "t1", args: {} },
        },
        { type: "step-finish", payload: assistantText("first") },
        { type: "step-start", payload: { messageId: "base" } },
        { type: "text-delta", payload: { text: "second" } },
        {
          type: "tool-call",
          payload: { toolCallId: "call-2", toolName: "t2", args: {} },
        },
        { type: "step-finish", payload: assistantText("second") },
        { type: "step-start", payload: { messageId: "base" } },
        { type: "text-delta", payload: { text: "third" } },
        { type: "finish", payload: assistantText("third") },
      ],
    });

    const events = await collectEvents(agent, makeInput());
    const ids = events
      .filter((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)
      .map((e) => (e as any).messageId);

    // One id per segment, none reused.
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe("base");
  });
});

/**
 * Resuming a suspended tool call. The previous run suppressed the call's
 * TOOL_CALL_START / ARGS / END, and Mastra's resume stream opens with the
 * call's tool-result before anything announces the turn's message id: the
 * first id arrives on the following step-finish. The call must render under
 * the id Mastra stores it under, exactly once, and the trailing text must land
 * after its result.
 */
describe("resumed suspended tool call identity", () => {
  const TURN_ID = "mastra-turn-resume";
  // Keep in sync with MastraAgent.continuationMessageId (private).
  const CONTINUATION_ID = `${TURN_ID}-agui-text`;
  const CALL_ID = "call-schedule";
  const MEMORY_CALL_ID = "call-memory";
  const MASTRA_RUN_ID = "mastra-run-1";
  const ARGS = { title: "Sync", time: "15:00" };

  // The resume order @mastra/client-js delivers, including the working-memory
  // result the first run's parallel `updateWorkingMemory` call leaves behind.
  function resumeChunks({
    announceId = true,
    beforeFirstId = [],
  }: { announceId?: boolean; beforeFirstId?: any[] } = {}) {
    const id = announceId ? { messageId: TURN_ID } : {};
    const chunk = (type: string, payload: Record<string, unknown>) => ({
      type,
      runId: MASTRA_RUN_ID,
      from: "AGENT",
      payload,
    });
    return [
      chunk("tool-result", {
        toolCallId: CALL_ID,
        toolName: "schedule_meeting",
        args: ARGS,
        result: { booked: true },
      }),
      chunk("tool-result", {
        toolCallId: MEMORY_CALL_ID,
        toolName: "updateWorkingMemory",
        args: { memory: "# Notes" },
        result: { success: true },
      }),
      ...beforeFirstId,
      chunk("step-finish", {
        ...id,
        stepResult: { reason: "tool-calls", isContinued: true },
      }),
      chunk("step-start", { ...id, request: { body: {} }, warnings: [] }),
      chunk("text-start", { id: "text-1" }),
      chunk("text-delta", { id: "text-1", text: "Booked for " }),
      chunk("text-delta", { id: "text-1", text: "3pm." }),
      chunk("text-end", { id: "text-1" }),
      chunk("step-finish", {
        ...id,
        stepResult: { reason: "stop", isContinued: false },
      }),
      chunk("finish", {
        ...id,
        stepResult: { reason: "stop", isContinued: false },
      }),
    ];
  }

  const resumeEntries = [
    {
      interruptId: `${MASTRA_RUN_ID}::${CALL_ID}`,
      status: "resolved" as const,
      payload: { approved: true },
    },
  ];

  const userTurn: Message = {
    id: "user-1",
    role: "user",
    content: "Book a sync at 3pm",
  };
  // The pending call as a client holding the full history has it.
  const historyWithCall: Message[] = [
    userTurn,
    {
      id: TURN_ID,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: CALL_ID,
          type: "function",
          function: {
            name: "schedule_meeting",
            arguments: JSON.stringify(ARGS),
          },
        },
      ],
    },
  ];

  const ofType = (events: BaseEvent[], type: EventType) =>
    events.filter((e) => e.type === type) as any[];

  // What the client ends up holding: the call once under TURN_ID with its
  // original arguments, then its result, then the trailing text.
  function expectCallResultThenText(
    messages: Message[],
    textMessageId: unknown = CONTINUATION_ID,
  ) {
    expect(messages.map((m) => [m.id, m.role])).toEqual([
      ["user-1", "user"],
      [TURN_ID, "assistant"],
      [expect.any(String), "tool"],
      [textMessageId, "assistant"],
    ]);
    const owner = messages[1] as AssistantMessage;
    expect(owner.toolCalls).toEqual([
      expect.objectContaining({
        id: CALL_ID,
        function: { name: "schedule_meeting", arguments: JSON.stringify(ARGS) },
      }),
    ]);
    expect(owner.content || "").toBe("");
    expect(messages[2]).toMatchObject({ toolCallId: CALL_ID });
    expect(messages[3].content).toBe("Booked for 3pm.");
    const callCopies = messages.flatMap(
      (m) =>
        (m as AssistantMessage).toolCalls?.filter((tc) => tc.id === CALL_ID) ??
        [],
    );
    expect(callCopies).toHaveLength(1);
  }

  describe("when the client already holds the call", () => {
    it("does not re-open the call and emits its result", async () => {
      const agent = makeRemoteMastraAgent({ resumeChunks: resumeChunks() });

      const events = await collectEvents(
        agent,
        makeInput({ messages: historyWithCall, resume: resumeEntries }),
      );

      for (const type of [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
      ]) {
        expect(ofType(events, type)).toEqual([]);
      }
      const results = ofType(events, EventType.TOOL_CALL_RESULT);
      expect(results.map((r) => r.toolCallId)).toEqual([CALL_ID]);
    });

    it("streams the trailing text under the continuation id, after the result", async () => {
      const agent = makeRemoteMastraAgent({ resumeChunks: resumeChunks() });

      const events = await collectEvents(
        agent,
        makeInput({ messages: historyWithCall, resume: resumeEntries }),
      );

      const text = ofType(events, EventType.TEXT_MESSAGE_CHUNK);
      expect(text.map((t) => t.messageId)).toEqual([
        CONTINUATION_ID,
        CONTINUATION_ID,
      ]);
      const result = ofType(events, EventType.TOOL_CALL_RESULT)[0];
      expect(events.indexOf(text[0])).toBeGreaterThan(events.indexOf(result));
    });

    it("leaves the client with one call, its result, then the text", async () => {
      const agent = makeRemoteMastraAgent({ resumeChunks: resumeChunks() });

      const messages = await runThroughClient(agent, historyWithCall, {
        runId: "run-2",
        resume: resumeEntries,
      });

      expectCallResultThenText(messages);
    });

    it("places the text after the result when the stream never announces an id", async () => {
      const agent = makeRemoteMastraAgent({
        resumeChunks: resumeChunks({ announceId: false }),
      });

      const messages = await runThroughClient(agent, historyWithCall, {
        runId: "run-2",
        resume: resumeEntries,
      });

      // With no id on the stream, the step boundary rotates to a fresh id.
      expectCallResultThenText(messages, expect.any(String));
      expect(messages[3].id).not.toBe(TURN_ID);
    });

    it("places text that directly follows the result after it", async () => {
      const [result] = resumeChunks();
      const agent = makeRemoteMastraAgent({
        resumeChunks: [
          result,
          {
            type: "text-delta",
            payload: { id: "t1", text: "Booked for 3pm." },
          },
          { type: "finish", payload: {} },
        ],
      });

      const messages = await runThroughClient(agent, historyWithCall, {
        runId: "run-2",
        resume: resumeEntries,
      });

      expectCallResultThenText(messages);
    });
  });

  describe("when the client does not hold the call", () => {
    it("opens the call under the id the stream announces after its result", async () => {
      const agent = makeRemoteMastraAgent({ resumeChunks: resumeChunks() });

      const events = await collectEvents(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      const starts = ofType(events, EventType.TOOL_CALL_START);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        toolCallId: CALL_ID,
        toolCallName: "schedule_meeting",
        parentMessageId: TURN_ID,
      });
      const [args] = ofType(events, EventType.TOOL_CALL_ARGS);
      const [end] = ofType(events, EventType.TOOL_CALL_END);
      const results = ofType(events, EventType.TOOL_CALL_RESULT);
      expect(JSON.parse(args.delta)).toEqual(ARGS);
      expect(results.map((r) => r.toolCallId)).toEqual([CALL_ID]);
      const order = [starts[0], args, end, results[0]].map((e) =>
        events.indexOf(e),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));

      const text = ofType(events, EventType.TEXT_MESSAGE_CHUNK);
      expect(new Set(text.map((t) => t.messageId))).toEqual(
        new Set([CONTINUATION_ID]),
      );
      expect(events.indexOf(text[0])).toBeGreaterThan(
        events.indexOf(results[0]),
      );
    });

    it("leaves the client with the call under the stored id, its result, then the text", async () => {
      const agent = makeRemoteMastraAgent({ resumeChunks: resumeChunks() });

      const messages = await runThroughClient(agent, [userTurn], {
        runId: "run-2",
        resume: resumeEntries,
      });

      expectCallResultThenText(messages);
    });

    it("falls back to the run's own id when the stream never announces one", async () => {
      const agent = makeRemoteMastraAgent({
        resumeChunks: resumeChunks({ announceId: false }),
      });

      const events = await collectEvents(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      const starts = ofType(events, EventType.TOOL_CALL_START);
      const results = ofType(events, EventType.TOOL_CALL_RESULT);
      expect(starts).toHaveLength(1);
      expect(starts[0].parentMessageId).toEqual(expect.any(String));
      expect(starts[0].parentMessageId).not.toBe(TURN_ID);
      expect(results.map((r) => r.toolCallId)).toEqual([CALL_ID]);
      expect(events.indexOf(results[0])).toBeGreaterThan(
        events.indexOf(starts[0]),
      );
      const text = ofType(events, EventType.TEXT_MESSAGE_CHUNK);
      expect(text.map((t) => t.delta).join("")).toBe("Booked for 3pm.");
      expect(events.indexOf(text[0])).toBeGreaterThan(
        events.indexOf(results[0]),
      );
    });

    const earlyText = (text: string, id = "text-0") => ({
      type: "text-delta",
      runId: MASTRA_RUN_ID,
      payload: { id, text },
    });

    it("holds output that arrives ahead of the id and emits it after the call, under that id", async () => {
      const agent = makeRemoteMastraAgent({
        resumeChunks: resumeChunks({ beforeFirstId: [earlyText("Done. ")] }),
      });

      const events = await collectEvents(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      const starts = ofType(events, EventType.TOOL_CALL_START);
      const results = ofType(events, EventType.TOOL_CALL_RESULT);
      const text = ofType(events, EventType.TEXT_MESSAGE_CHUNK);
      expect(starts).toHaveLength(1);
      expect(starts[0].parentMessageId).toBe(TURN_ID);
      expect(results.map((r) => r.toolCallId)).toEqual([CALL_ID]);
      expect(text.map((t) => t.delta)).toEqual([
        "Done. ",
        "Booked for ",
        "3pm.",
      ]);
      // Text after the call splits off the turn id, as it does live.
      expect(new Set(text.map((t) => t.messageId))).toEqual(
        new Set([CONTINUATION_ID]),
      );
      const order = [starts[0], results[0], text[0]].map((e) =>
        events.indexOf(e),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("keeps reasoning and other tool calls that arrive ahead of the id behind the call", async () => {
      const agent = makeRemoteMastraAgent({
        resumeChunks: resumeChunks({
          beforeFirstId: [
            {
              type: "reasoning-delta",
              runId: MASTRA_RUN_ID,
              payload: { text: "Confirming." },
            },
            {
              type: "tool-call",
              runId: MASTRA_RUN_ID,
              payload: {
                toolCallId: "call-notify",
                toolName: "notify",
                args: {},
              },
            },
            {
              type: "tool-result",
              runId: MASTRA_RUN_ID,
              payload: { toolCallId: "call-notify", result: { sent: true } },
            },
          ],
        }),
      });

      const events = await collectEvents(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      const starts = ofType(events, EventType.TOOL_CALL_START);
      expect(starts.map((s) => [s.toolCallId, s.parentMessageId])).toEqual([
        [CALL_ID, TURN_ID],
        ["call-notify", TURN_ID],
      ]);
      const results = ofType(events, EventType.TOOL_CALL_RESULT);
      expect(results.map((r) => r.toolCallId)).toEqual([
        CALL_ID,
        "call-notify",
      ]);
      const [reasoning] = ofType(events, EventType.REASONING_MESSAGE_CONTENT);
      expect(reasoning.delta).toBe("Confirming.");
      const order = [
        starts[0],
        results[0],
        reasoning,
        starts[1],
        results[1],
      ].map((e) => events.indexOf(e));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("leaves the client with the call under the stored id when output arrives ahead of the id, and the next turn does not duplicate it", async () => {
      const memory = new FakeMemory();
      const fake = new FakeLocalAgent({
        memory,
        resumeChunks: resumeChunks({ beforeFirstId: [earlyText("Done. ")] }),
        streamChunks: [
          { type: "start", payload: { messageId: "mastra-turn-next" } },
          { type: "text-delta", payload: { text: "ok" } },
          { type: "finish", payload: {} },
        ],
      });
      const agent = new MastraAgent({
        agentId: "test-agent",
        agent: fake as any,
        resourceId: "resource-1",
      });

      const messages = await runThroughClient(agent, [userTurn], {
        runId: "run-2",
        resume: resumeEntries,
      });

      expect(messages.map((m) => [m.id, m.role, m.content ?? ""])).toEqual([
        ["user-1", "user", "Book a sync at 3pm"],
        [TURN_ID, "assistant", ""],
        [expect.any(String), "tool", expect.any(String)],
        [CONTINUATION_ID, "assistant", "Done. Booked for 3pm."],
      ]);
      expect(
        messages.flatMap(
          (m) =>
            (m as AssistantMessage).toolCalls?.map((tc) => [m.id, tc.id]) ?? [],
        ),
      ).toEqual([[TURN_ID, CALL_ID]]);

      // Mastra stored the resumed turn under its own id. The next turn re-sends
      // the transcript; the call may only travel under that stored id, where
      // Mastra upserts it, never under an id it would append as a new copy.
      memory.recallMessages = [{ id: "user-1" }, { id: TURN_ID }];
      await runThroughClient(
        agent,
        [...messages, { id: "user-2", role: "user", content: "Thanks" }],
        { runId: "run-3" },
      );

      const forwarded = fake.lastStreamMessages ?? [];
      expect(
        forwarded
          .filter(
            (m: any) =>
              m.role === "assistant" && JSON.stringify(m).includes(CALL_ID),
          )
          .map((m: any) => m.id),
      ).toEqual([TURN_ID]);
      expect(JSON.stringify(forwarded)).toContain("Thanks");
    });

    // Keep in sync with MAX_DEFERRED_CHUNKS in mastra.ts.
    const DEFERRED_CHUNK_LIMIT = 1000;

    it("stops holding once the output ahead of the id fills the buffer, and drops nothing", async () => {
      const deltas = Array.from({ length: DEFERRED_CHUNK_LIMIT + 1 }, (_, i) =>
        earlyText(`${i} `),
      );
      const agent = makeRemoteMastraAgent({
        resumeChunks: resumeChunks({ beforeFirstId: deltas }),
      });

      const events = await collectEvents(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      const starts = ofType(events, EventType.TOOL_CALL_START);
      const results = ofType(events, EventType.TOOL_CALL_RESULT);
      const text = ofType(events, EventType.TEXT_MESSAGE_CHUNK);
      expect(starts).toHaveLength(1);
      expect(starts[0].parentMessageId).toEqual(expect.any(String));
      expect(starts[0].parentMessageId).not.toBe(TURN_ID);
      expect(results.map((r) => r.toolCallId)).toEqual([CALL_ID]);
      expect(text.map((t) => t.delta).join("")).toBe(
        deltas.map((d) => d.payload.text).join("") + "Booked for 3pm.",
      );
      // The held output went out under the run's own id, not the turn's.
      for (const t of text.slice(0, deltas.length)) {
        expect(t.messageId).not.toBe(TURN_ID);
        expect(t.messageId).not.toBe(CONTINUATION_ID);
      }
      const order = [starts[0], results[0], text[0]].map((e) =>
        events.indexOf(e),
      );
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it.each([
      ["the stream ends", [] as any[]],
      [
        "a finish without an id ends the stream",
        [{ type: "finish", runId: MASTRA_RUN_ID, payload: {} }],
      ],
    ])(
      "emits the held call, its result and the output ahead of the id when %s",
      async (_case, tail) => {
        const [result] = resumeChunks();
        const agent = makeRemoteMastraAgent({
          resumeChunks: [result, earlyText("Done."), ...tail],
        });

        const events = await collectEvents(
          agent,
          makeInput({ messages: [userTurn], resume: resumeEntries }),
        );

        expect(events.map((e) => e.type)).toEqual([
          EventType.RUN_STARTED,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
          EventType.TEXT_MESSAGE_CHUNK,
          EventType.RUN_FINISHED,
        ]);
        expect(ofType(events, EventType.TEXT_MESSAGE_CHUNK)[0].delta).toBe(
          "Done.",
        );
      },
    );

    it("keeps holding the call across observational-memory chunks that emit nothing", async () => {
      const agent = makeRemoteMastraAgent({
        observationalMemory: true,
        resumeChunks: resumeChunks({
          beforeFirstId: [
            { type: "data-om-status", data: { tokens: 120 } },
            { type: "data-om-thread-update", data: { title: "Sync" } },
          ],
        }),
      });

      const events = await collectEvents(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      const [start] = ofType(events, EventType.TOOL_CALL_START);
      expect(start.parentMessageId).toBe(TURN_ID);
    });

    it("emits the call and its result when the stream ends right after the result", async () => {
      const [result] = resumeChunks();
      const agent = makeRemoteMastraAgent({ resumeChunks: [result] });

      const events = await collectEvents(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.RUN_FINISHED,
      ]);
    });

    const expectCallAndResultBeforeError = (events: BaseEvent[]) => {
      expect(events.map((e) => e.type)).toEqual([
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
        EventType.RUN_ERROR,
      ]);
      expect(ofType(events, EventType.TOOL_CALL_RESULT)[0].toolCallId).toBe(
        CALL_ID,
      );
    };

    it("emits the call and its result before an error chunk", async () => {
      const [result] = resumeChunks();
      const agent = makeRemoteMastraAgent({
        resumeChunks: [
          result,
          { type: "error", runId: MASTRA_RUN_ID, payload: { error: "boom" } },
        ],
      });

      const { events } = await collectRunError(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      expectCallAndResultBeforeError(events);
    });

    it("emits the call and its result before a remote stream failure", async () => {
      const [result] = resumeChunks();
      const remote = new FakeRemoteAgent();
      remote.resumeStream = async () => ({
        processDataStream: async ({ onChunk }) => {
          await onChunk(result);
          throw new Error("connection reset");
        },
      });
      const agent = new MastraAgent({
        agentId: "test-agent",
        agent: remote as any,
        resourceId: "resource-1",
      });

      const { error, events } = await collectRunError(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      expect(error.message).toBe("connection reset");
      expectCallAndResultBeforeError(events);
    });

    it("emits the call and its result before a local stream failure", async () => {
      const [result] = resumeChunks();
      const local = new FakeLocalAgent();
      local.resumeStream = async () => ({
        fullStream: (async function* () {
          yield result;
          throw new Error("model crashed");
        })(),
      });
      const agent = new MastraAgent({
        agentId: "test-agent",
        agent: local as any,
        resourceId: "resource-1",
      });

      const { error, events } = await collectRunError(
        agent,
        makeInput({ messages: [userTurn], resume: resumeEntries }),
      );

      expect(error.message).toBe("model crashed");
      expectCallAndResultBeforeError(events);
    });

    it.each([
      [
        "an error chunk",
        () =>
          makeRemoteMastraAgent({
            resumeChunks: [
              resumeChunks()[0],
              earlyText("Done."),
              {
                type: "error",
                runId: MASTRA_RUN_ID,
                payload: { error: "boom" },
              },
            ],
          }),
      ],
      [
        "a remote stream failure",
        () => {
          const remote = new FakeRemoteAgent();
          remote.resumeStream = async () => ({
            processDataStream: async ({ onChunk }) => {
              await onChunk(resumeChunks()[0]);
              await onChunk(earlyText("Done."));
              throw new Error("connection reset");
            },
          });
          return new MastraAgent({
            agentId: "test-agent",
            agent: remote as any,
            resourceId: "resource-1",
          });
        },
      ],
      [
        "a local stream failure",
        () => {
          const local = new FakeLocalAgent();
          local.resumeStream = async () => ({
            fullStream: (async function* () {
              yield resumeChunks()[0];
              yield earlyText("Done.");
              throw new Error("model crashed");
            })(),
          });
          return new MastraAgent({
            agentId: "test-agent",
            agent: local as any,
            resourceId: "resource-1",
          });
        },
      ],
    ])(
      "emits the held call, its result and the output ahead of the id before %s",
      async (_case, makeAgent) => {
        const { events } = await collectRunError(
          makeAgent(),
          makeInput({ messages: [userTurn], resume: resumeEntries }),
        );

        expect(events.map((e) => e.type)).toEqual([
          EventType.RUN_STARTED,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
          EventType.TEXT_MESSAGE_CHUNK,
          EventType.RUN_ERROR,
        ]);
        expect(ofType(events, EventType.TOOL_CALL_RESULT)[0].toolCallId).toBe(
          CALL_ID,
        );
        expect(ofType(events, EventType.TEXT_MESSAGE_CHUNK)[0].delta).toBe(
          "Done.",
        );
      },
    );
  });

  // An earlier step of the suspended turn already split text off the turn id,
  // so the resumed text needs the next continuation id, not that one.
  describe("when the turn already has continuation text", () => {
    const EARLIER_CALL_ID = "call-lookup";
    const earlierCall = {
      id: EARLIER_CALL_ID,
      type: "function" as const,
      function: { name: "lookup", arguments: "{}" },
    };
    const pendingCall = {
      id: CALL_ID,
      type: "function" as const,
      function: { name: "schedule_meeting", arguments: JSON.stringify(ARGS) },
    };
    const historyFor = (toolCalls: (typeof earlierCall)[]): Message[] => [
      userTurn,
      { id: TURN_ID, role: "assistant", content: "Checking.", toolCalls },
      {
        id: "result-lookup",
        role: "tool",
        toolCallId: EARLIER_CALL_ID,
        content: '"free at 3pm"',
      },
      {
        id: CONTINUATION_ID,
        role: "assistant",
        content: "Booking it, need approval.",
      },
    ];

    it.each([
      ["already holds the pending call", [earlierCall, pendingCall]],
      ["does not hold the pending call", [earlierCall]],
    ])(
      "streams the resumed text as a new message when the client %s",
      async (_case, toolCalls) => {
        const agent = makeRemoteMastraAgent({ resumeChunks: resumeChunks() });

        const messages = await runThroughClient(agent, historyFor(toolCalls), {
          runId: "run-2",
          resume: resumeEntries,
        });

        expect(messages.map((m) => [m.id, m.role, m.content ?? ""])).toEqual([
          ["user-1", "user", "Book a sync at 3pm"],
          [TURN_ID, "assistant", "Checking."],
          ["result-lookup", "tool", '"free at 3pm"'],
          // The client files a result right after its call's tool results.
          [expect.any(String), "tool", expect.any(String)],
          [CONTINUATION_ID, "assistant", "Booking it, need approval."],
          [`${CONTINUATION_ID}-2`, "assistant", "Booked for 3pm."],
        ]);
        expect(messages[3]).toMatchObject({ toolCallId: CALL_ID });
        expect(
          (messages[1] as AssistantMessage).toolCalls?.map((tc) => tc.id),
        ).toEqual([EARLIER_CALL_ID, CALL_ID]);
      },
    );
  });
});
