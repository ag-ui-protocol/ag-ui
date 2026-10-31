import { describe, it, expect } from "vitest";
import { EventType } from "@ag-ui/client";
import { collectEvents } from "./helpers";
import {
  FIRST_TURN,
  PATHS,
  attributed,
  canonical,
  capture,
  isDelegatedChunk,
  type CaptureName,
} from "./subagent-helpers";

// `subagentVisibility: "hidden"` (the default) is the bridge as it was before
// sub-agents could be attributed: a delegated sub-agent's stream is dropped
// and the client sees the delegating call and its result only. These tests
// pin that contract on real Mastra delegation streams, so attribution can
// never leak into a client that did not ask for it. The one difference is the
// run's token usage, which includes its sub-agents' calls in every visibility
// (subagent-usage.test.ts).

/** The events with RUN_FINISHED's usage left out. */
const withoutRunUsage = (events: any[]) =>
  events.map((event) =>
    event.type === EventType.RUN_FINISHED
      ? { ...event, usage: undefined }
      : event,
  );

const DELEGATING: CaptureName[] = [
  "a-single",
  "b-parallel",
  "c-nested",
  "d-subtool-throws",
  "e-approval",
  "e2-suspend",
  "f-submodel-error",
  "f2-submodel-throws",
  "g-subagent-tripwire",
  "h-abort",
  "j-subagent-data-chunks",
  "m-delegation-plus-client-tool",
];

// Tool output that is not a delegation: a plain tool's writer and a workflow.
const NOT_DELEGATING: CaptureName[] = [
  "i-plain-tool-writer",
  "k-workflow-tool",
];

describe.each(PATHS)("subagentVisibility (%s)", (_path, make) => {
  describe('"hidden" (the default)', () => {
    it.each(DELEGATING)(
      "%s streams exactly as it does without the delegated chunks",
      async (name) => {
        const chunks = capture(name);
        const withDelegated = await collectEvents(
          make(chunks).agent,
          FIRST_TURN,
        );
        const without = await collectEvents(
          make(chunks.filter((chunk) => !isDelegatedChunk(chunk))).agent,
          FIRST_TURN,
        );
        expect(chunks.some(isDelegatedChunk)).toBe(true);
        expect(canonical(withoutRunUsage(withDelegated))).toBe(
          canonical(withoutRunUsage(without)),
        );
      },
    );

    it.each(DELEGATING)("%s carries no sub-agent attribution", async (name) => {
      const events = await collectEvents(make(capture(name)).agent, FIRST_TURN);
      expect(
        events.filter((event) => String(event.type).startsWith("SUBAGENT_")),
      ).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("subagentRunId");
    });

    it('is what an explicit "hidden" streams', async () => {
      const chunks = capture("c-nested");
      expect(
        canonical(
          await collectEvents(
            make(chunks, { subagentVisibility: "hidden" }).agent,
            FIRST_TURN,
          ),
        ),
      ).toBe(canonical(await collectEvents(make(chunks).agent, FIRST_TURN)));
    });

    it("is the only thing the gate holds back: the same stream attributed differs", async () => {
      // A tripwire for the gate: if delegated chunks reached the stream
      // without "attributed", the identity tests above would still pass only
      // if attribution itself were broken, so prove attribution is live here.
      const events = await collectEvents(
        make(capture("a-single"), attributed).agent,
        FIRST_TURN,
      );
      expect(
        events.filter((event) => event.type === EventType.SUBAGENT_STARTED),
      ).toHaveLength(1);
    });
  });

  describe('"attributed"', () => {
    it.each(NOT_DELEGATING)(
      "%s attributes nothing: only delegations map to sub-agents",
      async (name) => {
        const chunks = capture(name);
        expect(
          canonical(
            await collectEvents(make(chunks, attributed).agent, FIRST_TURN),
          ),
        ).toBe(canonical(await collectEvents(make(chunks).agent, FIRST_TURN)));
      },
    );
  });
});
