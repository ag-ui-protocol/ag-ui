import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import { collectEvents } from "./helpers";
import {
  FIRST_TURN,
  PATHS,
  attributed,
  capture,
  chunkIndex,
  gatedLocal,
  gatedRemote,
  localAgent,
  ofType,
  outline,
  runAndStop,
  stableOutline,
  verified,
} from "./subagent-helpers";

// A supervisor delegates to `mid` (`deleg-top`), which delegates to `leaf`
// (`mid-deleg-1`). Mastra wraps the leaf's chunks twice: once as mid's tool
// output, and that again as the supervisor's.

const SUPERVISOR_MESSAGE = "3f42d823-455a-4291-8633-1a859ca29b5a";
const MID_MESSAGE = "deleg-top/3082d1ef-d4bb-4f96-878e-f1f789507c76";
const LEAF = "deleg-top/mid-deleg-1";
const LEAF_MESSAGE = `${LEAF}/97ae152c-eb1b-4667-bdfe-3574b1dd82e1`;

describe.each(PATHS)("a nested attributed delegation (%s)", (_path, make) => {
  it("is an invocation inside its parent's, with ids namespaced under it", async () => {
    const chunks = capture("c-nested");
    const events = await collectEvents(
      make(chunks, attributed).agent,
      FIRST_TURN,
    );
    expect(stableOutline(events, chunks)).toEqual([
      "RUN_STARTED",
      `TEXT_MESSAGE_CHUNK ${SUPERVISOR_MESSAGE}`,
      "TOOL_CALL_START deleg-top",
      "TOOL_CALL_ARGS deleg-top",
      "TOOL_CALL_END deleg-top",
      "SUBAGENT_STARTED deleg-top mid",
      `TEXT_MESSAGE_CHUNK ${MID_MESSAGE} [deleg-top]`,
      `TOOL_CALL_START ${LEAF} [deleg-top]`,
      `TOOL_CALL_ARGS ${LEAF} [deleg-top]`,
      `TOOL_CALL_ARGS ${LEAF} [deleg-top]`,
      `TOOL_CALL_END ${LEAF} [deleg-top]`,
      `SUBAGENT_STARTED ${LEAF} leaf <deleg-top`,
      `REASONING_START ${LEAF}/<id> [${LEAF}]`,
      `REASONING_MESSAGE_START ${LEAF}/<id> [${LEAF}]`,
      `REASONING_MESSAGE_CONTENT ${LEAF}/<id> [${LEAF}]`,
      `REASONING_MESSAGE_END ${LEAF}/<id> [${LEAF}]`,
      `REASONING_END ${LEAF}/<id> [${LEAF}]`,
      `TEXT_MESSAGE_CHUNK ${LEAF_MESSAGE} [${LEAF}]`,
      `TEXT_MESSAGE_CHUNK ${LEAF_MESSAGE} [${LEAF}]`,
      `TOOL_CALL_START ${LEAF}/sub-call-leaf-0 [${LEAF}]`,
      `TOOL_CALL_ARGS ${LEAF}/sub-call-leaf-0 [${LEAF}]`,
      `TOOL_CALL_ARGS ${LEAF}/sub-call-leaf-0 [${LEAF}]`,
      `TOOL_CALL_END ${LEAF}/sub-call-leaf-0 [${LEAF}]`,
      `TOOL_CALL_RESULT ${LEAF}/sub-call-leaf-0 [${LEAF}]`,
      `TEXT_MESSAGE_CHUNK ${LEAF_MESSAGE}-agui-text [${LEAF}]`,
      // The leaf ends before mid's call returns, which is before mid ends.
      `SUBAGENT_FINISHED ${LEAF}`,
      `TOOL_CALL_RESULT ${LEAF} [deleg-top]`,
      `TEXT_MESSAGE_CHUNK ${MID_MESSAGE}-agui-text [deleg-top]`,
      "SUBAGENT_FINISHED deleg-top",
      "TOOL_CALL_RESULT deleg-top",
      `TEXT_MESSAGE_CHUNK ${SUPERVISOR_MESSAGE}-agui-text`,
      "RUN_FINISHED",
    ]);
    await verified(events);
  });

  it("names its parent invocation, call and message", async () => {
    const events = await collectEvents(
      make(capture("c-nested"), attributed).agent,
      FIRST_TURN,
    );
    expect(ofType(events, EventType.SUBAGENT_STARTED)[1]).toEqual({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: LEAF,
      name: "leaf",
      parentSubagentRunId: "deleg-top",
      parentToolCallId: LEAF,
      parentMessageId: MID_MESSAGE,
    });
  });

  it("closes deepest first when the run stops inside it", async () => {
    const chunks = capture("c-nested");
    const cutAt =
      chunkIndex(
        chunks,
        (chunk) =>
          chunk.payload?.output?.payload?.output?.type === "text-delta",
      ) + 1;
    const gated = (_path === "local" ? gatedLocal : gatedRemote)(
      chunks,
      cutAt,
      attributed,
    );
    const events = await runAndStop(
      gated.agent,
      FIRST_TURN,
      (event) =>
        event.type === EventType.TEXT_MESSAGE_CHUNK &&
        event.subagentRunId === LEAF,
    );
    gated.release();

    expect(outline(events).slice(-3)).toEqual([
      `SUBAGENT_ERROR ${LEAF} CANCELLED`,
      "SUBAGENT_ERROR deleg-top CANCELLED",
      "RUN_FINISHED",
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: { type: "cancelled" } });
    await verified(events);
  });
});

describe("a nested attributed delegation of a local supervisor", () => {
  it("is described from its parent's own agents", async () => {
    const { agent } = localAgent(capture("c-nested"), attributed, {
      listAgents: async () => ({
        mid: {
          getDescription: () => "Coordinates.",
          listAgents: async () => ({
            leaf: { getDescription: () => "Looks things up." },
          }),
        },
      }),
    });
    const events = await collectEvents(agent, FIRST_TURN);
    expect(
      ofType(events, EventType.SUBAGENT_STARTED).map((e) => e.description),
    ).toEqual(["Coordinates.", "Looks things up."]);
  });
});
