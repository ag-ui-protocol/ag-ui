import { describe, expect, it } from "vitest";
import { InterruptSchema, ResumeEntrySchema } from "../types";

describe("InterruptSchema", () => {
  it("accepts an interrupt with only required fields", () => {
    const parsed = InterruptSchema.parse({ id: "int-1", reason: "tool_call" });
    expect(parsed).toEqual({ id: "int-1", reason: "tool_call" });
  });

  it("accepts all standardized optional fields", () => {
    const input = {
      id: "int-1",
      reason: "input_required",
      message: "Approve?",
      toolCallId: "tc-1",
      responseSchema: { type: "object" },
      expiresAt: "2026-04-22T00:00:00Z",
      metadata: { foo: "bar" },
    };
    expect(InterruptSchema.parse(input)).toEqual(input);
  });

  it("rejects when id is missing", () => {
    expect(() => InterruptSchema.parse({ reason: "tool_call" })).toThrow();
  });

  it("rejects when reason is missing", () => {
    expect(() => InterruptSchema.parse({ id: "int-1" })).toThrow();
  });
});

describe("ResumeEntrySchema", () => {
  it("accepts resolved entry with payload", () => {
    const parsed = ResumeEntrySchema.parse({
      interruptId: "int-1",
      status: "resolved",
      payload: { approved: true },
    });
    expect(parsed.status).toBe("resolved");
    expect(parsed.payload).toEqual({ approved: true });
  });

  it("accepts cancelled entry without payload", () => {
    const parsed = ResumeEntrySchema.parse({
      interruptId: "int-1",
      status: "cancelled",
    });
    expect(parsed.status).toBe("cancelled");
    expect(parsed.payload).toBeUndefined();
  });

  it("rejects unknown status value", () => {
    expect(() =>
      ResumeEntrySchema.parse({ interruptId: "int-1", status: "denied" }),
    ).toThrow();
  });
});
