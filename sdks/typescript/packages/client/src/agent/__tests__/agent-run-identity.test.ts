/**
 * A run's boundary events must agree about which run, and which thread, they
 * are about.
 *
 * `run-input.mdx`: "Every run on the stream carries the input's `threadId` on
 * its boundary events — `RUN_STARTED` and `RUN_FINISHED`, the two that carry
 * identity — and each run's two boundary events MUST agree on their `runId`."
 *
 * Nothing compared these ids before: `RUN_STARTED(t1, r1)` followed by
 * `RUN_FINISHED(tX, rZ)` was accepted end to end, and its result was adopted as
 * the result of the run that was actually open. The checks live in
 * `verifyEvents`, so these tests drive the real pipeline to prove they are
 * reached — a verifier-only test would pass while the pipeline ignored it.
 *
 * The thread has one more authority than the verifier can see by itself: the
 * INPUT. `agent.ts` hands it in, so the very first RUN_STARTED is answerable
 * too — a producer answering about a conversation nobody asked about is a
 * violation even though such a stream is internally consistent.
 */
import { Observable, Subject } from "rxjs";
import { transformHttpEventStream } from "@/transform/http";
import { HttpEventType, type HttpEvent } from "@/run/http-request";
import { AbstractAgent } from "../agent";
import { BaseEvent, EventType, RunAgentInput } from "@ag-ui/core";

/** Replays scripted frames through the real SSE transport, as the wire does. */
class WireAgent extends AbstractAgent {
  constructor(
    private frames: unknown[],
    threadId = "t-main",
  ) {
    super({ threadId });
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

async function silencingErrors<T>(body: () => Promise<T>): Promise<T> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await body();
  } finally {
    errors.mockRestore();
  }
}

const started = (threadId: string, runId: string) => ({
  type: EventType.RUN_STARTED,
  threadId,
  runId,
});
const finished = (threadId: string, runId: string) => ({
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  outcome: { type: "success" },
});

describe("a run's two boundary events must name the same run", () => {
  it("fails the run when RUN_FINISHED names a different runId", async () => {
    const agent = new WireAgent([started("t-main", "r1"), finished("t-main", "r2")]);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(
        /must agree on their runId/,
      );
    });
  });

  it("names both ids, so the producer can see which pair disagreed", async () => {
    const agent = new WireAgent([started("t-main", "r1"), finished("t-main", "r2")]);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(/'r2'.*'r1'/);
    });
  });

  it("accepts the ordinary case, where they agree", async () => {
    const agent = new WireAgent([started("t-main", "r1"), finished("t-main", "r1")]);
    await expect(agent.runAgent({ runId: "r1" })).resolves.toBeDefined();
  });
});

describe("every run on a stream belongs to the same thread", () => {
  it("fails the run when RUN_FINISHED names a different threadId", async () => {
    const agent = new WireAgent([started("t-main", "r1"), finished("t-other", "r1")]);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(
        /A run's boundary events carry the input's threadId/,
      );
    });
  });

  it("fails the run when a SECOND run opens on a different thread", async () => {
    // A stream legitimately carries several runs — a replayed thread is the
    // common case — but they are runs on ONE conversation.
    const agent = new WireAgent([
      started("t-main", "r1"),
      finished("t-main", "r1"),
      started("t-other", "r2"),
      finished("t-other", "r2"),
    ]);

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(
        /this stream belongs to thread 't-main'/,
      );
    });
  });

  it("accepts several runs that all name the same thread", async () => {
    const agent = new WireAgent([
      started("t-main", "r1"),
      finished("t-main", "r1"),
      started("t-main", "r2"),
      finished("t-main", "r2"),
    ]);
    await expect(agent.runAgent({ runId: "r1" })).resolves.toBeDefined();
  });
});

describe("the thread the producer answers about, against the one requested", () => {
  it("fails the very first run when the producer answers about another thread", async () => {
    // The client asked about "t-asked"; the producer answers about
    // "t-answered". Internally the stream is perfectly consistent — both
    // boundary events agree — so the input is the only thing that can catch it.
    const agent = new WireAgent(
      [started("t-answered", "r1"), finished("t-answered", "r1")],
      "t-asked",
    );

    await silencingErrors(async () => {
      await expect(agent.runAgent({ runId: "r1" })).rejects.toThrow(
        /this stream belongs to thread 't-asked'/,
      );
    });
  });

  it("accepts the run when the producer echoes the thread it was given", async () => {
    const agent = new WireAgent([started("t-main", "r1"), finished("t-main", "r1")], "t-main");
    await expect(agent.runAgent({ runId: "r1" })).resolves.toBeDefined();
  });
});
