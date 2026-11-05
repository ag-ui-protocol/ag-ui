import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import { collectEvents, collectRunError } from "./helpers";
import {
  FIRST_TURN,
  PATHS,
  attributed,
  capture,
  chunkIndex,
  gatedLocal,
  gatedRemote,
  indexOf,
  ofType,
  outline,
  runAndStop,
  verified,
} from "./subagent-helpers";

// How an attributed invocation ends when something goes wrong, on real Mastra
// streams: a sub-agent's failure is its own (SUBAGENT_ERROR, the run goes on),
// and an invocation the run leaves open is ended with the run.

const lastTerminal = (events: any[]) =>
  events.filter(
    (e) =>
      e.type === EventType.SUBAGENT_FINISHED ||
      e.type === EventType.SUBAGENT_ERROR,
  );

describe.each(PATHS)(
  "an attributed delegation that fails (%s)",
  (_path, make) => {
    it.each([
      ["f-submodel-error", "deleg-f", "model stream exploded"],
      ["f2-submodel-throws", "deleg-f2", "doStream threw"],
    ] as const)(
      "ends as SUBAGENT_ERROR with the model's message only when the sub-agent's model fails (%s)",
      async (name, call, message) => {
        const events = await collectEvents(
          make(capture(name), attributed).agent,
          FIRST_TURN,
        );
        expect(lastTerminal(events)).toEqual([
          {
            type: EventType.SUBAGENT_ERROR,
            subagentRunId: call,
            message,
            code: "MASTRA_SUBAGENT_ERROR",
          },
        ]);
        // The inner error's stack trace never reaches the stream.
        expect(JSON.stringify(events)).not.toMatch(/stack|doStream \(/);
        // The supervisor's failed call is answered, after the invocation ends,
        // and the run carries on to its own answer.
        const ended = indexOf(
          events,
          (e) => e.type === EventType.SUBAGENT_ERROR,
        );
        const answered = indexOf(
          events,
          (e) => e.type === EventType.TOOL_CALL_RESULT && e.toolCallId === call,
        );
        expect(ended).toBeLessThan(answered);
        expect(JSON.parse(events[answered].content as string)).toEqual({
          error:
            "[Agent:supervisor] - Failed agent tool execution for researcher",
        });
        expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
        expect(events.at(-1)).not.toHaveProperty("outcome");
        await verified(events);
      },
    );

    it("answers a sub-agent's failed tool with its error and still finishes", async () => {
      const events = await collectEvents(
        make(capture("d-subtool-throws"), attributed).agent,
        FIRST_TURN,
      );
      expect(ofType(events, EventType.TOOL_CALL_RESULT)[0]).toMatchObject({
        toolCallId: "deleg-d/sub-call-d-0",
        content: JSON.stringify({ error: "lookup exploded" }),
        subagentRunId: "deleg-d",
      });
      expect(lastTerminal(events)).toEqual([
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "deleg-d" },
      ]);
      await verified(events);
    });

    it("ends as SUBAGENT_ERROR MASTRA_TRIPWIRE when a processor blocks the sub-agent", async () => {
      const events = await collectEvents(
        make(capture("g-subagent-tripwire"), attributed).agent,
        FIRST_TURN,
      );
      expect(lastTerminal(events)).toEqual([
        {
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: "deleg-g",
          message: "blocked by guard",
          code: "MASTRA_TRIPWIRE",
        },
      ]);
      // The reason is the invocation's end, not text of the sub-agent's.
      expect(
        ofType(events, EventType.TEXT_MESSAGE_CHUNK).filter(
          (e) => e.subagentRunId,
        ),
      ).toEqual([]);
      await verified(events);
    });

    it("ends as SUBAGENT_ERROR CANCELLED when the sub-agent is aborted", async () => {
      const events = await collectEvents(
        make(capture("h-abort"), attributed).agent,
        FIRST_TURN,
      );
      expect(lastTerminal(events)).toEqual([
        {
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: "deleg-h",
          message: "The sub-agent run was aborted.",
          code: "CANCELLED",
        },
      ]);
      // Mastra's own top-level abort is what cancels the run.
      expect(events.at(-1)).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: "cancelled" },
      });
      await verified(events);
    });
  },
);

describe.each(PATHS)(
  "a run that ends during an attributed delegation (%s)",
  (path, make) => {
    const gated = path === "local" ? gatedLocal : gatedRemote;

    it("ends the invocation once, then the run as cancelled, when stopped", async () => {
      const chunks = capture("a-single");
      // Cut while the sub-agent's tool call is still streaming its arguments.
      const cutAt =
        chunkIndex(
          chunks,
          (chunk) => chunk.payload?.output?.type === "tool-call-delta",
        ) + 1;
      const run = gated(chunks, cutAt, attributed);
      const events = await runAndStop(
        run.agent,
        FIRST_TURN,
        (event) =>
          event.type === EventType.TOOL_CALL_ARGS &&
          event.toolCallId === "deleg-1/sub-call-a-0",
      );
      run.release();

      expect(outline(events).slice(-3)).toEqual([
        // The open call closes inside the invocation, before it ends.
        "TOOL_CALL_END deleg-1/sub-call-a-0 [deleg-1]",
        "SUBAGENT_ERROR deleg-1 CANCELLED",
        "RUN_FINISHED",
      ]);
      expect(ofType(events, EventType.SUBAGENT_ERROR)).toEqual([
        {
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: "deleg-1",
          message: "The run stopped before the sub-agent finished.",
          code: "CANCELLED",
        },
      ]);
      expect(ofType(events, EventType.RUN_FINISHED)).toEqual([
        expect.objectContaining({ outcome: { type: "cancelled" } }),
      ]);
      await verified(events);
    });

    it("ends the invocation before the RUN_ERROR of a run that fails", async () => {
      const chunks = capture("a-single");
      const cutAt =
        chunkIndex(
          chunks,
          (chunk) => chunk.payload?.output?.type === "tool-result",
        ) + 1;
      const failing = [
        ...chunks.slice(0, cutAt),
        { type: "error", from: "AGENT", payload: { error: "provider down" } },
      ];
      const { events } = await collectRunError(
        make(failing, attributed).agent,
        FIRST_TURN,
      );
      expect(outline(events).slice(-2)).toEqual([
        "SUBAGENT_ERROR deleg-1",
        "RUN_ERROR",
      ]);
      expect(ofType(events, EventType.SUBAGENT_ERROR)[0]).toEqual({
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: "deleg-1",
        message: "provider down",
      });
      await verified(events);
    });

    it("ends an invocation the stream never answered when the run finishes", async () => {
      // A stream that ends without the delegation's result: the invocation is
      // ended with the run, and its unanswered call is answered for it.
      const chunks = capture("a-single");
      const cutAt = chunkIndex(
        chunks,
        (chunk) => chunk.payload?.output?.type === "tool-call-delta",
      );
      const events = await collectEvents(
        make(chunks.slice(0, cutAt + 2), attributed).agent,
        FIRST_TURN,
      );
      expect(outline(events).slice(-5)).toEqual([
        "TOOL_CALL_END deleg-1/sub-call-a-0 [deleg-1]",
        "TOOL_CALL_RESULT deleg-1/sub-call-a-0 [deleg-1]",
        "SUBAGENT_FINISHED deleg-1",
        "TOOL_CALL_RESULT deleg-1",
        "RUN_FINISHED",
      ]);
      await verified(events);
    });
  },
);
