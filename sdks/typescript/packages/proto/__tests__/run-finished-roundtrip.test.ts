import { describe, expect, it } from "vitest";
import { encode, decode } from "../src/proto";
import { EventType, RunFinishedEvent } from "@ag-ui/core";
import { expectRoundTripEquality } from "./test-utils";

describe("RunFinishedEvent — proto round-trip", () => {
  it("round-trips a legacy event with no outcome", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
    };
    expectRoundTripEquality(event);
  });

  it("round-trips a legacy event with no outcome but with a result", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      result: { answer: 42 },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips a success event with result", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
      result: { answer: 42 },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips a success event without result", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips an interrupt event with full Interrupt fields", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "int-1",
            reason: "tool_call",
            message: "Approve?",
            toolCallId: "tc-1",
            responseSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
            },
            expiresAt: "2099-01-01T00:00:00Z",
            metadata: { langgraph: { checkpointId: "ckpt-1" } },
          },
        ],
      },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips an interrupt event with multiple minimal interrupts", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          { id: "int-1", reason: "tool_call" },
          { id: "int-2", reason: "confirmation" },
        ],
      },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips an interrupt event with complex responseSchema", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "int-complex",
            reason: "tool_call",
            message: "Complex approval needed",
            responseSchema: {
              type: "object",
              properties: {
                approved: { type: "boolean" },
                feedback: { type: "string" },
                rating: { type: "number", minimum: 1, maximum: 5 },
              },
              required: ["approved"],
              additionalProperties: false,
            },
            metadata: {
              system: "approval_engine",
              version: "2.0",
              nested: { deep: { value: "test" } },
            },
          },
        ],
      },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips an interrupt event with timestamp", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      timestamp: Date.now(),
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "int-ts",
            reason: "confirmation",
            expiresAt: "2099-12-31T23:59:59Z",
          },
        ],
      },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips a success event with complex result object", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: { type: "success" },
      result: {
        analysis: {
          conclusion: "Complete",
          metrics: { accuracy: 0.95, confidence: 0.87 },
          details: ["step1", "step2", "step3"],
        },
      },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips an interrupt with all optional Interrupt fields populated", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      threadId: "t-1",
      runId: "r-1",
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: "int-full",
            reason: "human_approval_required",
            message: "Awaiting user confirmation",
            toolCallId: "tool-xyz",
            responseSchema: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["approve", "reject", "defer"],
                },
              },
            },
            expiresAt: "2099-06-15T12:00:00Z",
            metadata: {
              priority: "high",
              requiredApprovers: ["admin@example.com"],
            },
          },
        ],
      },
    };
    expectRoundTripEquality(event);
  });

  it("round-trips a RunFinishedEvent with all base fields including timestamp and rawEvent", () => {
    const event: RunFinishedEvent = {
      type: EventType.RUN_FINISHED,
      timestamp: Date.now(),
      threadId: "t-full",
      runId: "r-full",
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "int-1", reason: "tool_call" }],
      },
      rawEvent: { originalData: "from_external_system" },
    };
    expectRoundTripEquality(event);
  });
});
