import { afterEach, describe, expect, it, vi } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/client";
import {
  collectEvents,
  FakeLocalAgent,
  FakeRemoteAgent,
  makeInput,
  makeLocalMastraAgent,
  makeRemoteMastraAgent,
} from "./helpers";

function serverCall(toolCallId = "tc-server", q = "x") {
  const toolName = "deep_research";
  return [
    {
      type: "tool-call-input-streaming-start",
      payload: { toolCallId, toolName },
    },
    {
      type: "tool-call-delta",
      payload: { toolCallId, argsTextDelta: '{"q":' },
    },
    {
      type: "tool-call-delta",
      payload: { toolCallId, argsTextDelta: `${JSON.stringify(q)}}` },
    },
    { type: "tool-call-input-streaming-end", payload: { toolCallId } },
    { type: "tool-call", payload: { toolCallId, toolName, args: { q } } },
  ];
}

function backgroundStart(toolCallId = "tc-server") {
  return {
    type: "background-task-started",
    payload: {
      taskId: `task-${toolCallId}`,
      toolCallId,
      toolName: "deep_research",
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Pause the producer after the final call, before the tool can complete. This
// checks subscriber visibility during execution, not just final event order.
function pauseBeforeResult(kind: "local" | "remote", resume: boolean) {
  const reached = deferred();
  const release = deferred();
  const result = {
    type: "tool-result",
    payload: { toolCallId: "tc-server", result: { ok: true } },
  };
  const method = resume ? "resumeStream" : "stream";
  if (kind === "local") {
    vi.spyOn(FakeLocalAgent.prototype, method).mockImplementation(async () => ({
      fullStream: (async function* () {
        for (const chunk of serverCall()) yield chunk;
        reached.resolve();
        await release.promise;
        yield result;
      })(),
    }));
  } else {
    const processDataStream: Awaited<
      ReturnType<FakeRemoteAgent["stream"]>
    >["processDataStream"] = async ({ onChunk }) => {
      for (const chunk of serverCall()) await onChunk(chunk);
      reached.resolve();
      await release.promise;
      await onChunk(result);
    };
    vi.spyOn(FakeRemoteAgent.prototype, method).mockResolvedValue({
      processDataStream,
    });
  }
  return { reached, release };
}

afterEach(() => vi.restoreAllMocks());

describe.each([
  ["local", makeLocalMastraAgent],
  ["remote", makeRemoteMastraAgent],
] as const)("%s server-tool streaming", (kind, makeAgent) => {
  describe.each([false, true])("streamServerToolCalls=%s", (enabled) => {
    it.each([false, true])(
      "exposes the call before completion only when enabled (resume=%s)",
      async (resume) => {
        const gate = pauseBeforeResult(kind, resume);
        const agent = makeAgent({ streamServerToolCalls: enabled });
        const events: BaseEvent[] = [];
        const input = makeInput(
          resume
            ? {
                resume: [
                  {
                    interruptId: "previous-run::suspended",
                    status: "resolved",
                    payload: { approved: true },
                  },
                ],
              }
            : {},
        );
        const done = new Promise<void>((resolve, reject) => {
          agent.run(input).subscribe({
            next: (event) => events.push(event),
            error: reject,
            complete: resolve,
          });
        });
        try {
          await Promise.race([
            gate.reached.promise,
            done.then(() => {
              throw new Error("Run completed before reaching the tool result");
            }),
          ]);
          expect(
            events.filter((e) => e.type === EventType.TOOL_CALL_START),
          ).toHaveLength(enabled ? 1 : 0);
          expect(
            events.filter((e) => e.type === EventType.TOOL_CALL_ARGS),
          ).toMatchObject(
            enabled ? [{ delta: '{"q":' }, { delta: '"x"}' }] : [],
          );
          expect(
            events.filter((e) => e.type === EventType.TOOL_CALL_RESULT),
          ).toHaveLength(0);
        } finally {
          gate.release.resolve();
          await done;
        }
        expect(
          events.filter((e) => e.type === EventType.TOOL_CALL_START),
        ).toHaveLength(1);
        expect(
          events.filter((e) => e.type === EventType.TOOL_CALL_RESULT),
        ).toHaveLength(1);
      },
    );

    it("preserves assembled arguments when the call becomes an activity", async () => {
      const agent = makeAgent({
        streamServerToolCalls: enabled,
        streamChunks: [
          ...serverCall(),
          backgroundStart(),
          {
            type: "tool-result",
            payload: {
              toolCallId: "tc-server",
              result: "running in background",
            },
          },
          { type: "finish", payload: { finishReason: "stop" } },
        ],
      });
      const events = await collectEvents(agent, makeInput());
      expect(
        events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT),
      ).toMatchObject([{ content: { args: { q: "x" }, status: "running" } }]);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_START),
      ).toHaveLength(enabled ? 1 : 0);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_END),
      ).toHaveLength(enabled ? 1 : 0);
      // A streamed call is answered when the run ends, so it is not left
      // pending for the application.
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_RESULT),
      ).toMatchObject(enabled ? [{ toolCallId: "tc-server" }] : []);
    });
  });

  it("keeps arguments associated with each interleaved streamed call", async () => {
    const agent = makeAgent({
      streamServerToolCalls: true,
      streamChunks: [
        ...serverCall("first", "first query"),
        ...serverCall("second", "second query"),
        backgroundStart("first"),
        backgroundStart("second"),
      ],
    });
    const events = await collectEvents(agent, makeInput());
    expect(
      events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT),
    ).toMatchObject([
      { content: { toolCallId: "first", args: { q: "first query" } } },
      { content: { toolCallId: "second", args: { q: "second query" } } },
    ]);
  });

  describe("a failed server tool", () => {
    const finish = { type: "finish", payload: { finishReason: "stop" } };
    const toolError = (error: unknown, toolCallId = "tc-server") => ({
      type: "tool-error",
      payload: { toolCallId, toolName: "deep_research", error },
    });

    describe.each([false, true])("streamServerToolCalls=%s", (enabled) => {
      it("answers the call with the error as its result", async () => {
        const agent = makeAgent({
          streamServerToolCalls: enabled,
          streamChunks: [
            ...serverCall(),
            toolError({ message: "kaboom" }),
            finish,
          ],
        });
        const events = await collectEvents(agent, makeInput());
        const callEvents = events.filter(
          (e) =>
            e.type === EventType.TOOL_CALL_START ||
            e.type === EventType.TOOL_CALL_END ||
            e.type === EventType.TOOL_CALL_RESULT,
        );
        expect(callEvents.map((e) => e.type)).toEqual([
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
        ]);
        expect(callEvents[2]).toMatchObject({
          toolCallId: "tc-server",
          content: JSON.stringify({ error: "kaboom" }),
        });
      });
    });

    it("leaves the client nothing pending", async () => {
      const agent = makeAgent({
        streamChunks: [
          ...serverCall(),
          toolError({ message: "kaboom" }),
          finish,
        ],
      });
      let pending: unknown;
      await agent.runAgent(
        {},
        {
          onRunFinishedEvent: (params) => {
            pending = params.outcome === "success" && params.pendingToolCallIds;
          },
        },
      );
      expect(pending).toEqual([]);
      expect(agent.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          toolCallId: "tc-server",
          content: JSON.stringify({ error: "kaboom" }),
        }),
      );
    });

    it.each([
      ["an Error", new Error("kaboom"), "kaboom"],
      ["a string", "kaboom", "kaboom"],
      [
        "an object without a message",
        { code: "E_TIMEOUT" },
        '{"code":"E_TIMEOUT"}',
      ],
      ["nothing", undefined, "Unknown error"],
    ])("reads the message from %s", async (_label, error, message) => {
      const agent = makeAgent({
        streamChunks: [...serverCall(), toolError(error), finish],
      });
      const events = await collectEvents(agent, makeInput());
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_RESULT),
      ).toMatchObject([{ content: JSON.stringify({ error: message }) }]);
    });

    it("reads the message of a background dispatch failure the same way", async () => {
      const agent = makeAgent({
        streamChunks: [
          ...serverCall(),
          backgroundStart(),
          toolError({ code: "E_TIMEOUT" }),
          finish,
        ],
      });
      const events = await collectEvents(agent, makeInput());
      expect(
        events.filter((e) => e.type === EventType.ACTIVITY_DELTA),
      ).toMatchObject([
        {
          patch: [
            { path: "/status", value: "failed" },
            { path: "/error", value: '{"code":"E_TIMEOUT"}' },
          ],
        },
      ]);
      expect(
        events.filter((e) => e.type === EventType.TOOL_CALL_RESULT),
      ).toHaveLength(0);
    });

    it("emits no result for a failed working-memory update", async () => {
      const agent = makeAgent({
        streamChunks: [
          {
            type: "tool-call",
            payload: {
              toolCallId: "tc-wm",
              toolName: "updateWorkingMemory",
              args: { memory: "{}" },
            },
          },
          {
            type: "tool-error",
            payload: {
              toolCallId: "tc-wm",
              toolName: "updateWorkingMemory",
              error: { message: "storage down" },
            },
          },
          finish,
        ],
      });
      const events = await collectEvents(agent, makeInput());
      expect(
        events.filter(
          (e) =>
            e.type === EventType.TOOL_CALL_START ||
            e.type === EventType.TOOL_CALL_RESULT,
        ),
      ).toHaveLength(0);
    });
  });
});
