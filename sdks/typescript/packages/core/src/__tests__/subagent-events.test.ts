import { describe, it, expect } from "vitest";
import {
  TextMessageStartEventSchema,
  TextMessageChunkEventSchema,
  ToolCallStartEventSchema,
  ToolCallChunkEventSchema,
  ToolCallResultEventSchema,
  ReasoningMessageChunkEventSchema,
  StateDeltaEventSchema,
  StepStartedEventSchema,
  CustomEventSchema,
  EventType,
} from "../events";

describe("event subagentId attribution", () => {
  it("accepts subagentId on creation events", () => {
    expect(
      TextMessageStartEventSchema.parse({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        subagentId: "sub-1",
      }).subagentId,
    ).toBe("sub-1");
    expect(
      ToolCallStartEventSchema.parse({
        type: EventType.TOOL_CALL_START,
        toolCallId: "tc1",
        toolCallName: "search",
        subagentId: "sub-2",
      }).subagentId,
    ).toBe("sub-2");
    expect(
      ToolCallResultEventSchema.parse({
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tm1",
        toolCallId: "tc1",
        content: "done",
        subagentId: "sub-3",
      }).subagentId,
    ).toBe("sub-3");
  });

  it("accepts subagentId on all chunk events", () => {
    expect(
      TextMessageChunkEventSchema.parse({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "m1",
        subagentId: "sub-7",
      }).subagentId,
    ).toBe("sub-7");
    expect(
      ToolCallChunkEventSchema.parse({
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "tc1",
        subagentId: "sub-8",
      }).subagentId,
    ).toBe("sub-8");
    expect(
      ReasoningMessageChunkEventSchema.parse({
        type: EventType.REASONING_MESSAGE_CHUNK,
        messageId: "r1",
        delta: "thinking",
        subagentId: "sub-9",
      }).subagentId,
    ).toBe("sub-9");
  });

  it("accepts subagentId on standalone events", () => {
    expect(
      StateDeltaEventSchema.parse({
        type: EventType.STATE_DELTA,
        delta: [],
        subagentId: "sub-4",
      }).subagentId,
    ).toBe("sub-4");
    expect(
      StepStartedEventSchema.parse({
        type: EventType.STEP_STARTED,
        stepName: "s",
        subagentId: "sub-5",
      }).subagentId,
    ).toBe("sub-5");
    expect(
      CustomEventSchema.parse({
        type: EventType.CUSTOM,
        name: "n",
        value: 1,
        subagentId: "sub-6",
      }).subagentId,
    ).toBe("sub-6");
  });
});
