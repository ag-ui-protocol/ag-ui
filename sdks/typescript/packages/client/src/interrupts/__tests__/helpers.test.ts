import { describe, expect, it } from "vitest";
import type { Interrupt, RunFinishedEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { getRunOutcome, isInterruptExpired, buildResumeArray } from "../index";

describe("getRunOutcome", () => {
  it("returns the outcome of a success event", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "success",
    };
    expect(getRunOutcome(event)).toBe("success");
  });

  it("returns the outcome of an interrupt event", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "interrupt",
      interrupts: [{ id: "int-1", reason: "tool_call" }],
    };
    expect(getRunOutcome(event)).toBe("interrupt");
  });
});

describe("isInterruptExpired", () => {
  it("returns false when expiresAt is unset", () => {
    const i: Interrupt = { id: "int-1", reason: "tool_call" };
    expect(isInterruptExpired(i)).toBe(false);
  });

  it("returns true when expiresAt is in the past", () => {
    const i: Interrupt = { id: "int-1", reason: "tool_call", expiresAt: "2000-01-01T00:00:00Z" };
    expect(isInterruptExpired(i)).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    const i: Interrupt = { id: "int-1", reason: "tool_call", expiresAt: "2099-01-01T00:00:00Z" };
    expect(isInterruptExpired(i)).toBe(false);
  });

  it("honors injected `now` for deterministic tests", () => {
    const i: Interrupt = { id: "int-1", reason: "tool_call", expiresAt: "2026-04-22T12:00:00Z" };
    expect(isInterruptExpired(i, new Date("2026-04-22T11:59:00Z"))).toBe(false);
    expect(isInterruptExpired(i, new Date("2026-04-22T12:00:01Z"))).toBe(true);
  });
});

describe("buildResumeArray", () => {
  const interrupts: Interrupt[] = [
    { id: "int-1", reason: "tool_call" },
    { id: "int-2", reason: "tool_call" },
  ];

  it("builds an array addressing every interrupt", () => {
    const resume = buildResumeArray(interrupts, {
      "int-1": { status: "resolved", payload: { approved: true } },
      "int-2": { status: "cancelled" },
    });
    expect(resume).toHaveLength(2);
    expect(resume[0]).toEqual({
      interruptId: "int-1",
      status: "resolved",
      payload: { approved: true },
    });
    expect(resume[1]).toEqual({ interruptId: "int-2", status: "cancelled" });
    expect(resume[1]).not.toHaveProperty("payload");
  });

  it("throws when a response is missing for an open interrupt", () => {
    expect(() =>
      buildResumeArray(interrupts, {
        "int-1": { status: "resolved", payload: { approved: true } },
      }),
    ).toThrow(/int-2/);
  });

  it("throws when responses reference an unknown interrupt id", () => {
    expect(() =>
      buildResumeArray(interrupts, {
        "int-1": { status: "resolved" },
        "int-2": { status: "cancelled" },
        "int-3": { status: "cancelled" },
      }),
    ).toThrow(/int-3/);
  });
});
