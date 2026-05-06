import { describe, expect, it } from "vitest";
import { defaultEventValidator } from "../validator";
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
      expect((result.value as { role: string }).role).toBe("assistant");
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
      expect((result.value as { replace: boolean }).replace).toBe(true);
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
      expect((result.value as { outcome?: unknown }).outcome).toBeUndefined();
    }
  });
});
