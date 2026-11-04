import { describe, it, expect, vi, afterEach } from "vitest";
import { EventType, type Message } from "@ag-ui/client";
import { collectEvents, makeInput, runThroughClient } from "./helpers";
import {
  FIRST_TURN,
  PATHS,
  attributed,
  capture,
  localAgent,
  ofType,
  outline,
  remoteAgent,
  stableOutline,
  verified,
  type CaptureName,
} from "./subagent-helpers";

// A tool inside a delegated sub-agent pauses: for approval
// (`requireApproval`) or by suspending. Mastra reports the pause on the
// supervisor's delegating call, which is also what resuming addresses, and
// streams the resumed sub-agent on under the same call.

afterEach(() => {
  vi.restoreAllMocks();
});

const CASES = [
  {
    kind: "approval",
    first: "e-approval",
    resume: "e-approval-resume",
    call: "deleg-e",
    innerCall: "deleg-e/sub-call-e-0",
    interruptId:
      "mastra-approval::9ec2cbdf-8f0f-49bc-aa1f-d6952100bcad::deleg-e",
    reason: "mastra:tool_approval",
    payload: { approved: true },
    supervisorMessage: "70874eb8-0255-4a13-b6ee-639c5f35e654",
    resumedMessage: "deleg-e/9c3ae9cc-0453-42e1-a2ea-e01aa80af1ab",
    resumedSupervisorMessage: "6f6647a6-e15c-44fd-bbca-5f4b1bd2271b",
  },
  {
    kind: "suspend",
    first: "e2-suspend",
    resume: "e2-suspend-resume",
    call: "deleg-e2",
    innerCall: "deleg-e2/sub-call-e2-0",
    interruptId: "fd4da0d4-85a7-4095-bb46-a2b6a50f4053::deleg-e2",
    reason: "mastra:tool_suspend",
    payload: { answer: "yes" },
    supervisorMessage: "dbfa6230-b685-41b9-81c8-13a7b1266488",
    resumedMessage: "deleg-e2/86322ca1-a949-448a-b94b-e27a19c3373d",
    resumedSupervisorMessage: "af767189-9b83-40b6-bc5e-5b054ababb2f",
  },
] as const;

describe.each(PATHS)(
  "a pause inside an attributed delegation (%s)",
  (path, make) => {
    describe.each(CASES)("$kind", (c) => {
      it("is an interrupt attributed to the invocation, which ends suspended", async () => {
        const events = await collectEvents(
          make(capture(c.first as CaptureName), attributed).agent,
          FIRST_TURN,
        );
        const finished = events.at(-1) as any;
        expect(finished.type).toBe(EventType.RUN_FINISHED);
        expect(finished.outcome.type).toBe("interrupt");
        expect(finished.outcome.interrupts).toEqual([
          expect.objectContaining({
            id: c.interruptId,
            reason: c.reason,
            toolCallId: c.call,
            subagentRunId: c.call,
          }),
        ]);
        expect(ofType(events, EventType.SUBAGENT_FINISHED)).toEqual([
          {
            type: EventType.SUBAGENT_FINISHED,
            subagentRunId: c.call,
            outcome: { type: "suspended", interruptIds: [c.interruptId] },
          },
        ]);
        // The paused call is closed and left unanswered until it resumes.
        expect(outline(events)).toContain(
          `TOOL_CALL_END ${c.innerCall} [${c.call}]`,
        );
        expect(
          ofType(events, EventType.TOOL_CALL_RESULT).map((e) => e.toolCallId),
        ).not.toContain(c.innerCall);
        await verified(events);
      });

      it("resumes the same invocation, answering the call the client holds", async () => {
        const warn = vi.spyOn(console, "warn");
        const first = make(capture(c.first as CaptureName), attributed);
        const history: Message[] = await runThroughClient(
          first.agent,
          FIRST_TURN.messages,
          {},
        );
        const resumeChunks = capture(c.resume as CaptureName);
        const second =
          path === "local"
            ? localAgent([], attributed)
            : remoteAgent([], attributed);
        second.fake.resumeChunks = resumeChunks;
        const resume = makeInput({
          runId: "run-2",
          messages: history,
          resume: [
            {
              interruptId: c.interruptId,
              status: "resolved",
              payload: c.payload,
            },
          ],
        });
        const events = await collectEvents(second.agent, resume);

        expect(stableOutline(events, resumeChunks)).toEqual([
          "RUN_STARTED",
          `SUBAGENT_STARTED ${c.call} researcher`,
          `TOOL_CALL_RESULT ${c.innerCall} [${c.call}]`,
          `TEXT_MESSAGE_CHUNK ${c.resumedMessage} [${c.call}]`,
          `SUBAGENT_FINISHED ${c.call}`,
          `TOOL_CALL_RESULT ${c.call}`,
          `TEXT_MESSAGE_CHUNK ${c.resumedSupervisorMessage}`,
          "RUN_FINISHED",
        ]);
        // The same id, so a client continues the invocation it already shows,
        // under the message that holds the delegating call.
        expect(ofType(events, EventType.SUBAGENT_STARTED)[0]).toMatchObject({
          subagentRunId: c.call,
          parentToolCallId: c.call,
          parentMessageId: c.supervisorMessage,
        });
        await verified(events);
        // Mastra's `tool-call-resumed` is recognized, not warned about.
        expect(
          warn.mock.calls.filter((args) =>
            String(args[0]).includes("tool-call-resumed"),
          ),
        ).toEqual([]);

        // Through the client, the resumed result lands on the held call.
        const third =
          path === "local"
            ? localAgent([], attributed)
            : remoteAgent([], attributed);
        third.fake.resumeChunks = resumeChunks;
        const messages = await runThroughClient(third.agent, history, {
          resume: resume.resume,
        });
        expect(
          messages.find(
            (m: any) => m.role === "tool" && m.toolCallId === c.innerCall,
          ),
        ).toMatchObject({ subagentRunId: c.call });
      });
    });

    it("is attributed to the deepest invocation it came from", async () => {
      // Scripted on the captured approval shapes, one level deeper: `mid`
      // (`deleg-top`) delegates to `researcher` (`mid-deleg`), whose tool asks
      // for approval; each level reports the pause on its delegating call.
      const researcher = capture("e-approval")
        .filter((chunk) => chunk.type === "tool-output")
        .map((chunk) => chunk.payload.output);
      const viaMid = (output: unknown) => ({
        type: "tool-output",
        from: "USER",
        payload: { toolCallId: "deleg-top", toolName: "agent-mid", output },
      });
      const viaResearcher = (output: unknown) =>
        viaMid({
          type: "tool-output",
          from: "USER",
          payload: {
            toolCallId: "mid-deleg",
            toolName: "agent-researcher",
            output,
          },
        });
      const approval = (toolCallId: string) => ({
        type: "tool-call-approval",
        runId: "supervisor-run",
        from: "AGENT",
        payload: { toolCallId, toolName: "lookup", args: { q: "e" } },
      });
      const chunks = [
        { type: "start", from: "AGENT", payload: { messageId: "sup" } },
        {
          type: "tool-call",
          from: "AGENT",
          payload: { toolCallId: "deleg-top", toolName: "agent-mid", args: {} },
        },
        viaMid({ type: "start", from: "AGENT", payload: { messageId: "mid" } }),
        viaMid({
          type: "tool-call",
          from: "AGENT",
          payload: {
            toolCallId: "mid-deleg",
            toolName: "agent-researcher",
            args: {},
          },
        }),
        ...researcher.map(viaResearcher),
        viaMid(approval("mid-deleg")),
        approval("deleg-top"),
      ];
      const interruptId = "mastra-approval::supervisor-run::deleg-top";

      const events = await collectEvents(
        make(chunks, attributed).agent,
        FIRST_TURN,
      );
      expect((events.at(-1) as any).outcome.interrupts).toEqual([
        expect.objectContaining({
          id: interruptId,
          toolCallId: "deleg-top",
          subagentRunId: "deleg-top/mid-deleg",
        }),
      ]);
      // The origin owns the interrupt; its parent is suspended because of it.
      expect(ofType(events, EventType.SUBAGENT_FINISHED)).toEqual([
        {
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: "deleg-top/mid-deleg",
          outcome: { type: "suspended", interruptIds: [interruptId] },
        },
        {
          type: EventType.SUBAGENT_FINISHED,
          subagentRunId: "deleg-top",
          outcome: { type: "suspended" },
        },
      ]);
      await verified(events);
    });
  },
);
