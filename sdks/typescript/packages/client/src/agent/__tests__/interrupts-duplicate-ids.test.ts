/**
 * Two interrupts under one id are rejected, because one resume entry would
 * answer both.
 *
 * `interrupt-resume.mdx`: "Each interrupt's `id` MUST be unique within the run;
 * a resume entry answers it by this id."
 *
 * The harm is specific, and the second test here pins it: the coverage check in
 * `onInitialize` — the rule that makes a resuming input safe by refusing to
 * start a run that leaves an interrupt unanswered — asks whether every pending
 * id appears in a `Set` of resume ids. Two interrupts sharing an id therefore
 * need only ONE resume entry to look fully answered, and the second question is
 * dropped without anyone being told: exactly the silent skip the coverage rule
 * exists to prevent. That check cannot tell the two apart by construction, which
 * is why the duplicate has to be rejected where it arrives — at the verifier.
 */
import { Observable, Subject } from "rxjs";
import { transformHttpEventStream } from "@/transform/http";
import { HttpEventType, type HttpEvent } from "@/run/http-request";
import { AbstractAgent } from "../agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";

/** Replays scripted frames through the real SSE transport, as the wire does. */
class WireAgent extends AbstractAgent {
  constructor(private frames: unknown[]) {
    super({ threadId: "t-int" });
    this.debug = false;
  }
  run(_input: RunAgentInput): Observable<BaseEvent> {
    const http = new Subject<HttpEvent>();
    const events$ = transformHttpEventStream(http);
    queueMicrotask(() => {
      http.next({
        type: HttpEventType.HEADERS,
        status: 200,
        headers: new Headers([["content-type", "text/event-stream"]]),
      });
      for (const frame of this.frames) {
        http.next({
          type: HttpEventType.DATA,
          data: new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
        });
      }
      http.complete();
    });
    return events$;
  }
}

/** Never reaches the wire: used to show what the coverage check alone does. */
class StubAgent extends AbstractAgent {
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

async function silencingErrors<T>(body: () => Promise<T>): Promise<T> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await body();
  } finally {
    errors.mockRestore();
  }
}

describe("duplicate interrupt ids in a RUN_FINISHED interrupt outcome", () => {
  it("is what the coverage check cannot catch: one answer covers both", async () => {
    // Not an assertion about desired behaviour — a demonstration of the harm.
    // `pendingInterrupts` is set directly, which is what the reducer would have
    // done had the stream carrying the duplicate been admitted. One resume
    // entry, two questions, and the run starts anyway: the second interrupt is
    // never answered and nobody is told.
    const agent = new StubAgent();
    agent.pendingInterrupts = [
      { id: "int-dup", reason: "approval", message: "approve the first tool call" },
      { id: "int-dup", reason: "approval", message: "approve the SECOND tool call" },
    ];

    await expect(
      agent.runAgent({
        resume: [{ interruptId: "int-dup", status: "resolved", payload: { approved: true } }],
      }),
    ).resolves.toBeDefined();
  });

  it("is rejected when the producer sends it, before it can reach that check", async () => {
    const agent = new WireAgent([
      { type: EventType.RUN_STARTED, threadId: "t-int", runId: "r-int" },
      {
        type: EventType.RUN_FINISHED,
        threadId: "t-int",
        runId: "r-int",
        outcome: {
          type: "interrupt",
          interrupts: [
            { id: "int-dup", reason: "approval", message: "approve the first tool call" },
            { id: "int-dup", reason: "approval", message: "approve the SECOND tool call" },
          ],
        },
      },
    ]);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r-int" })).rejects.toThrow(
        /two interrupts carrying the id 'int-dup'/,
      );
    });

    // And nothing was left pending from a stream the client refused.
    expect(agent.pendingInterrupts).toEqual([]);
  });

  it("accepts an interrupt outcome whose ids are distinct", async () => {
    const agent = new WireAgent([
      { type: EventType.RUN_STARTED, threadId: "t-int", runId: "r-int" },
      {
        type: EventType.RUN_FINISHED,
        threadId: "t-int",
        runId: "r-int",
        outcome: {
          type: "interrupt",
          interrupts: [
            { id: "int-1", reason: "approval" },
            { id: "int-2", reason: "approval" },
          ],
        },
      },
    ]);

    await expect(agent.runAgent({ runId: "r-int" })).resolves.toBeDefined();
    expect(agent.pendingInterrupts.map((i) => i.id)).toEqual(["int-1", "int-2"]);
  });
});
