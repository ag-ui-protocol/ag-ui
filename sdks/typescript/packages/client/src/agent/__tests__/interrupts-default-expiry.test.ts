/**
 * Interrupts that arrive without an expiresAt must not wedge their thread
 * forever (#2525).
 *
 * `isInterruptExpired` treats a missing expiresAt as "never expires", and
 * the resume-coverage check requires every pending interrupt to be
 * addressed before the thread can run again — so a producer that omits
 * expiresAt left the thread permanently blocked behind interrupts nobody
 * could ever retire. The client now stamps a bounded default expiry when
 * it records such an interrupt, and caps how many it tracks per thread.
 */

import { describe, expect, it } from "vitest";
import { of } from "rxjs";
import { AbstractAgent } from "../agent";
import type { BaseEvent, Interrupt, RunAgentInput } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import {
  DEFAULT_INTERRUPT_TTL_MS,
  MAX_PENDING_INTERRUPTS,
  isInterruptExpired,
} from "../../interrupts";

class InterruptOutcomeAgent extends AbstractAgent {
  public outcomeInterrupts: Interrupt[] = [];
  run(input: RunAgentInput) {
    return of(
      { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId } as BaseEvent,
      {
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: { type: "interrupt", interrupts: this.outcomeInterrupts },
      } as BaseEvent,
    );
  }
}

describe("AbstractAgent — interrupts without expiresAt (#2525)", () => {
  it("stamps a bounded default expiry on an interrupt that omits expiresAt", async () => {
    const agent = new InterruptOutcomeAgent();
    agent.outcomeInterrupts = [{ id: "int-1", reason: "tool_call" }];

    const before = Date.now();
    await agent.runAgent();
    const after = Date.now();

    expect(agent.pendingInterrupts).toHaveLength(1);
    const stamped = agent.pendingInterrupts[0]!.expiresAt;
    expect(stamped).toBeDefined();
    const expiry = Date.parse(stamped!);
    expect(expiry).toBeGreaterThanOrEqual(before + DEFAULT_INTERRUPT_TTL_MS - 1000);
    expect(expiry).toBeLessThanOrEqual(after + DEFAULT_INTERRUPT_TTL_MS + 1000);
    // Answerable now, expired once the default window has passed: the
    // thread can then be released by cancelling, like any expired
    // interrupt, instead of staying blocked forever.
    expect(isInterruptExpired(agent.pendingInterrupts[0]!)).toBe(false);
    expect(
      isInterruptExpired(
        agent.pendingInterrupts[0]!,
        new Date(after + DEFAULT_INTERRUPT_TTL_MS + 1000),
      ),
    ).toBe(true);
  });

  it("keeps a producer-supplied expiresAt untouched", async () => {
    const agent = new InterruptOutcomeAgent();
    agent.outcomeInterrupts = [
      { id: "int-1", reason: "tool_call", expiresAt: "2030-01-01T00:00:00.000Z" },
    ];

    await agent.runAgent();

    expect(agent.pendingInterrupts[0]!.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("does not mutate the emitted event's interrupt objects", async () => {
    const agent = new InterruptOutcomeAgent();
    const original: Interrupt = { id: "int-1", reason: "tool_call" };
    agent.outcomeInterrupts = [original];

    await agent.runAgent();

    expect(original.expiresAt).toBeUndefined();
    expect(agent.pendingInterrupts[0]).not.toBe(original);
  });

  it("caps the number of pending interrupts tracked per thread", async () => {
    const agent = new InterruptOutcomeAgent();
    agent.outcomeInterrupts = Array.from(
      { length: MAX_PENDING_INTERRUPTS + 5 },
      (_, i) => ({ id: `int-${i + 1}`, reason: "tool_call" }) as Interrupt,
    );

    await agent.runAgent();

    expect(agent.pendingInterrupts).toHaveLength(MAX_PENDING_INTERRUPTS);
    expect(agent.pendingInterrupts[0]!.id).toBe("int-1");
    expect(agent.pendingInterrupts[MAX_PENDING_INTERRUPTS - 1]!.id).toBe(
      `int-${MAX_PENDING_INTERRUPTS}`,
    );
  });
});
