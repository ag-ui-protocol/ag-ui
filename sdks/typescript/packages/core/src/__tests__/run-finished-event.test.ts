import { describe, expect, it } from "vitest";
import {
  EventSchemas,
  EventType,
  RunFinishedEventSchema,
  RunFinishedSuccessEventSchema,
  RunFinishedInterruptEventSchema,
} from "../events";

describe("RunFinishedEvent — success variant", () => {
  it("parses outcome='success' with a result", () => {
    const parsed = RunFinishedSuccessEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "success",
      result: { answer: 42 },
    });
    expect(parsed.outcome).toBe("success");
    expect(parsed.result).toEqual({ answer: 42 });
  });

  it("parses outcome='success' without result", () => {
    const parsed = RunFinishedSuccessEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "success",
    });
    expect(parsed.outcome).toBe("success");
    expect(parsed.result).toBeUndefined();
  });

  it("rejects outcome='success' with outcome literal mismatch", () => {
    expect(() =>
      RunFinishedSuccessEventSchema.parse({
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "r-1",
        outcome: "interrupt",
      }),
    ).toThrow();
  });
});

describe("RunFinishedEvent — interrupt variant", () => {
  it("parses outcome='interrupt' with non-empty interrupts", () => {
    const parsed = RunFinishedInterruptEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "interrupt",
      interrupts: [{ id: "int-1", reason: "tool_call" }],
    });
    expect(parsed.outcome).toBe("interrupt");
    expect(parsed.interrupts).toHaveLength(1);
  });

  it("rejects outcome='interrupt' with empty interrupts array", () => {
    expect(() =>
      RunFinishedInterruptEventSchema.parse({
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "r-1",
        outcome: "interrupt",
        interrupts: [],
      }),
    ).toThrow();
  });

  it("rejects outcome='interrupt' with missing interrupts", () => {
    expect(() =>
      RunFinishedInterruptEventSchema.parse({
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "r-1",
        outcome: "interrupt",
      }),
    ).toThrow();
  });
});

describe("RunFinishedEventSchema — discriminated by outcome via union", () => {
  it("parses both variants", () => {
    const success = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "success",
      result: "ok",
    });
    expect(success.outcome).toBe("success");

    const interrupt = RunFinishedEventSchema.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "interrupt",
      interrupts: [{ id: "int-1", reason: "tool_call" }],
    });
    expect(interrupt.outcome).toBe("interrupt");
  });

  it("rejects events without an outcome field", () => {
    expect(() =>
      RunFinishedEventSchema.parse({
        type: EventType.RUN_FINISHED,
        threadId: "t-1",
        runId: "r-1",
      }),
    ).toThrow();
  });
});

describe("EventSchemas — outer union routes RUN_FINISHED correctly", () => {
  it("parses a RUN_FINISHED success event through the outer union", () => {
    const parsed = EventSchemas.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "success",
    });
    expect(parsed.type).toBe(EventType.RUN_FINISHED);
    if (parsed.type === EventType.RUN_FINISHED) {
      expect(parsed.outcome).toBe("success");
    }
  });

  it("parses a RUN_FINISHED interrupt event through the outer union", () => {
    const parsed = EventSchemas.parse({
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: "interrupt",
      interrupts: [{ id: "int-1", reason: "tool_call" }],
    });
    expect(parsed.type).toBe(EventType.RUN_FINISHED);
  });
});
