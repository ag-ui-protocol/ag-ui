import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import { collectEvents, runThroughClient } from "./helpers";
import {
  FIRST_TURN,
  PATHS,
  attributed,
  capture,
  chunkIndex,
  indexOf,
  ofType,
  renamed,
  stableOutline,
  verified,
} from "./subagent-helpers";

// Two delegations from one supervisor step (`deleg-A` to `alpha`, `deleg-B`
// to `beta`), which Mastra runs concurrently: their chunks interleave one by
// one on the supervisor stream, and both results follow once both settle.

const SUPERVISOR_MESSAGE = "2ad23fba-ba63-4d3b-80b9-cb37175eeab1";
const ALPHA_MESSAGE = "deleg-A/20863542-2ad5-4dd9-a6e8-b0aed089b5fd";
const BETA_MESSAGE = "deleg-B/124e9ee1-0885-4bce-8470-4a596cea195f";

const isLane = (lane: string, type: string) => (chunk: any) =>
  chunk.type === "tool-output" &&
  chunk.payload.toolCallId === lane &&
  chunk.payload.output.type === type;

describe.each(PATHS)(
  "concurrent attributed delegations (%s)",
  (_path, make) => {
    it("stream side by side, each in its own invocation", async () => {
      const chunks = capture("b-parallel");
      const events = await collectEvents(
        make(chunks, attributed).agent,
        FIRST_TURN,
      );
      expect(stableOutline(events, chunks)).toEqual([
        "RUN_STARTED",
        `TEXT_MESSAGE_CHUNK ${SUPERVISOR_MESSAGE}`,
        // Every delegating call of the step goes out before any delegation.
        "TOOL_CALL_START deleg-A",
        "TOOL_CALL_ARGS deleg-A",
        "TOOL_CALL_END deleg-A",
        "TOOL_CALL_START deleg-B",
        "TOOL_CALL_ARGS deleg-B",
        "TOOL_CALL_END deleg-B",
        "SUBAGENT_STARTED deleg-A alpha",
        "SUBAGENT_STARTED deleg-B beta",
        "REASONING_START deleg-A/<id> [deleg-A]",
        "REASONING_MESSAGE_START deleg-A/<id> [deleg-A]",
        "REASONING_START deleg-B/<id> [deleg-B]",
        "REASONING_MESSAGE_START deleg-B/<id> [deleg-B]",
        "REASONING_MESSAGE_CONTENT deleg-A/<id> [deleg-A]",
        "REASONING_MESSAGE_CONTENT deleg-B/<id> [deleg-B]",
        "REASONING_MESSAGE_END deleg-A/<id> [deleg-A]",
        "REASONING_END deleg-A/<id> [deleg-A]",
        "REASONING_MESSAGE_END deleg-B/<id> [deleg-B]",
        "REASONING_END deleg-B/<id> [deleg-B]",
        `TEXT_MESSAGE_CHUNK ${ALPHA_MESSAGE} [deleg-A]`,
        `TEXT_MESSAGE_CHUNK ${BETA_MESSAGE} [deleg-B]`,
        `TEXT_MESSAGE_CHUNK ${ALPHA_MESSAGE} [deleg-A]`,
        `TEXT_MESSAGE_CHUNK ${BETA_MESSAGE} [deleg-B]`,
        "TOOL_CALL_START deleg-A/sub-call-alpha-0 [deleg-A]",
        "TOOL_CALL_START deleg-B/sub-call-beta-0 [deleg-B]",
        "TOOL_CALL_ARGS deleg-A/sub-call-alpha-0 [deleg-A]",
        "TOOL_CALL_ARGS deleg-B/sub-call-beta-0 [deleg-B]",
        "TOOL_CALL_ARGS deleg-A/sub-call-alpha-0 [deleg-A]",
        "TOOL_CALL_ARGS deleg-B/sub-call-beta-0 [deleg-B]",
        "TOOL_CALL_END deleg-A/sub-call-alpha-0 [deleg-A]",
        "TOOL_CALL_END deleg-B/sub-call-beta-0 [deleg-B]",
        "TOOL_CALL_RESULT deleg-A/sub-call-alpha-0 [deleg-A]",
        "TOOL_CALL_RESULT deleg-B/sub-call-beta-0 [deleg-B]",
        `TEXT_MESSAGE_CHUNK ${ALPHA_MESSAGE}-agui-text [deleg-A]`,
        `TEXT_MESSAGE_CHUNK ${BETA_MESSAGE}-agui-text [deleg-B]`,
        "SUBAGENT_FINISHED deleg-A",
        "TOOL_CALL_RESULT deleg-A",
        "SUBAGENT_FINISHED deleg-B",
        "TOOL_CALL_RESULT deleg-B",
        `TEXT_MESSAGE_CHUNK ${SUPERVISOR_MESSAGE}-agui-text`,
        "RUN_FINISHED",
      ]);
      await verified(events);
    });

    it("end independently: one finishing leaves the other streaming", async () => {
      // Scripted from the capture: alpha finishes (and its delegation returns)
      // while beta is still writing its answer.
      const chunks = capture("b-parallel");
      const alphaText = chunkIndex(
        chunks,
        (chunk) =>
          isLane("deleg-A", "text-delta")(chunk) &&
          chunk.payload.output.payload.text === "Answer from alpha.",
      );
      const alphaEnd = chunks.filter(
        (chunk, index) =>
          index > alphaText &&
          (isLane("deleg-A", "text-end")(chunk) ||
            isLane("deleg-A", "step-finish")(chunk) ||
            isLane("deleg-A", "finish")(chunk) ||
            (chunk.type === "tool-result" &&
              chunk.payload.toolCallId === "deleg-A")),
      );
      const rest = chunks.filter(
        (chunk, index) => index > alphaText && !alphaEnd.includes(chunk),
      );
      const reordered = [
        ...chunks.slice(0, alphaText + 1),
        ...alphaEnd,
        ...rest,
      ];

      const events = await collectEvents(
        make(reordered, attributed).agent,
        FIRST_TURN,
      );
      const alphaFinished = indexOf(
        events,
        (e) =>
          e.type === EventType.SUBAGENT_FINISHED &&
          e.subagentRunId === "deleg-A",
      );
      const betaAnswer = indexOf(
        events,
        (e) =>
          e.type === EventType.TEXT_MESSAGE_CHUNK &&
          e.delta === "Answer from beta.",
      );
      expect(alphaFinished).toBeLessThan(betaAnswer);
      expect(events[betaAnswer]).toMatchObject({
        messageId: `${BETA_MESSAGE}-agui-text`,
        subagentRunId: "deleg-B",
      });
      await verified(events);

      const messages = await runThroughClient(
        make(reordered, attributed).agent,
        FIRST_TURN.messages,
        {},
      );
      expect(
        messages.find((m) => m.id === `${BETA_MESSAGE}-agui-text`),
      ).toMatchObject({
        content: "Answer from beta.",
        subagentRunId: "deleg-B",
      });
    });

    it("never merge entities whose native ids collide across agents", async () => {
      // Providers (and mocks) reuse ids such as `call-1` across agents. Here
      // the supervisor's first delegation, both sub-agents' calls, and every
      // agent's message share their native ids.
      const chunks = renamed(capture("b-parallel"), {
        "deleg-A": "call-1",
        "sub-call-alpha-0": "call-1",
        "sub-call-beta-0": "call-1",
        [SUPERVISOR_MESSAGE]: "msg-1",
        "20863542-2ad5-4dd9-a6e8-b0aed089b5fd": "msg-1",
        "124e9ee1-0885-4bce-8470-4a596cea195f": "msg-1",
      });
      const messages = await runThroughClient(
        make(chunks, attributed).agent,
        FIRST_TURN.messages,
        {},
      );
      const calls = messages.flatMap((m: any) =>
        (m.toolCalls ?? []).map((call: any) => `${m.id}:${call.id}`),
      );
      expect(calls).toEqual([
        "msg-1:call-1",
        "msg-1:deleg-B",
        "call-1/msg-1:call-1/call-1",
        "deleg-B/msg-1:deleg-B/call-1",
      ]);
      const results = messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => m.toolCallId)
        .sort();
      expect(results).toEqual([
        "call-1",
        "call-1/call-1",
        "deleg-B",
        "deleg-B/call-1",
      ]);
    });

    it("report each invocation's own end", async () => {
      const events = await collectEvents(
        make(capture("b-parallel"), attributed).agent,
        FIRST_TURN,
      );
      expect(ofType(events, EventType.SUBAGENT_FINISHED)).toEqual([
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "deleg-A" },
        { type: EventType.SUBAGENT_FINISHED, subagentRunId: "deleg-B" },
      ]);
    });
  },
);
