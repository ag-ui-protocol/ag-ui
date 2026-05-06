import { describe, expect, it } from "vitest";
import { defaultEventValidator, fromStandardSchema } from "../validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { EventType } from "../events";

describe("defaultEventValidator", () => {
  it("accepts an event with a known EventType", () => {
    const result = defaultEventValidator.validateEvent({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.type).toBe(EventType.TEXT_MESSAGE_START);
    }
  });

  it("rejects an event with an unknown type", () => {
    const result = defaultEventValidator.validateEvent({
      type: "NOT_A_REAL_EVENT",
      messageId: "m1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object value", () => {
    const result = defaultEventValidator.validateEvent("nope");
    expect(result.success).toBe(false);
  });

  it("applies the role default for TEXT_MESSAGE_START when role is missing", () => {
    const result = defaultEventValidator.validateEvent({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "m1",
    });
    expect(result.success).toBe(true);
    if (result.success && result.value.type === EventType.TEXT_MESSAGE_START) {
      expect((result.value as unknown as { role: string }).role).toBe("assistant");
    }
  });

  it("applies the replace default for ACTIVITY_SNAPSHOT when replace is missing", () => {
    const result = defaultEventValidator.validateEvent({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "m1",
      activityType: "x",
      content: {},
    });
    expect(result.success).toBe(true);
    if (result.success && result.value.type === EventType.ACTIVITY_SNAPSHOT) {
      expect((result.value as unknown as { replace: boolean }).replace).toBe(true);
    }
  });

  it("normalizes RUN_FINISHED outcome=null to undefined", () => {
    const result = defaultEventValidator.validateEvent({
      type: EventType.RUN_FINISHED,
      threadId: "t",
      runId: "r",
      outcome: null,
    });
    expect(result.success).toBe(true);
    if (result.success && result.value.type === EventType.RUN_FINISHED) {
      expect((result.value as unknown as { outcome?: unknown }).outcome).toBeUndefined();
    }
  });

  it("rejects an array input even if it has a .type property", () => {
    const arr = Object.assign([1, 2, 3], { type: "TEXT_MESSAGE_START" });
    const result = defaultEventValidator.validateEvent(arr);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.message).toMatch(/non-null object/i);
    }
  });

  it("accepts events with unknown future fields (forward compatibility)", () => {
    // The protocol contract is that AG-UI events tolerate unknown future fields.
    // defaultEventValidator only checks the `type` tag; it must not reject events
    // because of additional unrecognized properties.
    const result = defaultEventValidator.validateEvent({
      type: EventType.RUN_STARTED,
      threadId: "t",
      runId: "r",
      // A field added by a hypothetical future protocol revision:
      futureExtension: { somethingNew: 42 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.type).toBe(EventType.RUN_STARTED);
      expect((result.value as { futureExtension?: unknown }).futureExtension).toEqual({
        somethingNew: 42,
      });
    }
  });
});

const makeSchema = <T>(
  validate: StandardSchemaV1<unknown, T>["~standard"]["validate"],
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate,
  },
});

describe("fromStandardSchema", () => {
  it("returns success when the underlying schema returns a value", () => {
    const schema = makeSchema<number>((input) => ({ value: 42 }));
    const validator = fromStandardSchema(schema);
    const result = validator("anything");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(42);
    }
  });

  it("returns failure with mapped issues when the underlying schema returns issues", () => {
    const schema = makeSchema<unknown>((input) => ({
      issues: [
        { message: "bad", path: ["a", { key: "b" }, 0] },
      ],
    }));
    const validator = fromStandardSchema(schema);
    const result = validator("anything");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.message).toBe("bad");
      expect(result.issues[0]?.path).toEqual(["a", "b", "0"]);
    }
  });

  it("treats an empty issues array as success", () => {
    const schema = makeSchema<string>((input) => ({
      value: "ok",
      issues: [],
    } as ReturnType<StandardSchemaV1<unknown, string>["~standard"]["validate"]>));
    const validator = fromStandardSchema(schema);
    const result = validator("anything");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe("ok");
    }
  });

  it("throws when the schema returns a Promise", () => {
    const schema = makeSchema<unknown>((input) =>
      Promise.resolve({ value: input }),
    );
    const validator = fromStandardSchema(schema);
    expect(() => validator("anything")).toThrowError(
      /does not support async/i,
    );
  });
});
