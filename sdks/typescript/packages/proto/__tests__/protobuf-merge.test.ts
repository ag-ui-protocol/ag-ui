import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { EventType } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { describe, expect, it } from "vitest";
import * as events from "../src/generated/events";
import * as types from "../src/generated/types";
import { Value } from "../src/generated/google/protobuf/struct";
import { decode } from "../src/proto";

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}

function field(number: number, ...payloads: Uint8Array[]): Uint8Array {
  return new BinaryWriter()
    .uint32(number * 8 + 2)
    .bytes(concat(...payloads))
    .finish();
}

function stepWithBases(...bases: Uint8Array[]): Uint8Array {
  return field(
    16,
    events.StepFinishedEvent.encode(
      events.StepFinishedEvent.create({
        baseEvent: { type: events.EventType.STEP_FINISHED },
        stepName: "plan",
      }),
    ).finish(),
    ...bases.map((base) => field(1, base)),
  );
}

describe("protobuf message merging", () => {
  it("merges partial occurrences of the same event", () => {
    const bytes = concat(
      field(
        12,
        events.RunStartedEvent.encode(
          events.RunStartedEvent.create({
            baseEvent: { type: events.EventType.RUN_STARTED },
            threadId: "t",
          }),
        ).finish(),
      ),
      field(
        12,
        events.RunStartedEvent.encode(events.RunStartedEvent.create({ runId: "r" })).finish(),
      ),
    );
    const decoded = decode(bytes);
    expect(decoded).toEqual({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" });
    expect(EventSchemas.parse(decoded)).toEqual(decoded);
  });

  it("preserves nested fields and appends repeated messages in order", () => {
    const input = (id: string) =>
      types.RunAgentInput.encode(
        types.RunAgentInput.create({
          threadId: "t",
          runId: "r",
          messages: [{ id, role: "user", content: id }],
        }),
      ).finish();
    const run = events.RunStartedEvent.encode(
      events.RunStartedEvent.create({
        baseEvent: { type: events.EventType.RUN_STARTED },
        threadId: "t",
        runId: "r",
      }),
    ).finish();
    const decoded = decode(field(12, run, field(5, input("first")), field(5, input("second"))));
    expect(decoded).toMatchObject({
      type: EventType.RUN_STARTED,
      input: {
        messages: [
          { id: "first", role: "user", content: "first" },
          { id: "second", role: "user", content: "second" },
        ],
      },
    });
    expect(EventSchemas.parse(decoded)).toEqual(decoded);
  });

  it("merges metadata maps while retaining null values and replacing duplicate keys", () => {
    const base = (metadata: { first?: number; second?: null; replace: string }) =>
      events.BaseEvent.encode(events.BaseEvent.create({ metadata })).finish();
    expect(
      decode(
        stepWithBases(
          base({ first: 1, replace: "before" }),
          base({ second: null, replace: "after" }),
        ),
      ),
    ).toEqual({
      type: EventType.STEP_FINISHED,
      stepName: "plan",
      metadata: { first: 1, second: null, replace: "after" },
    });
  });

  it("lets an explicitly encoded default overwrite an earlier scalar", () => {
    const timestamp = (value: number) => new BinaryWriter().uint32(16).int64(value).finish();
    expect(decode(stepWithBases(timestamp(9), timestamp(0)))).toMatchObject({ timestamp: 0 });
  });

  it.each([
    { values: [{ first: 1 }, { second: null }], expected: { first: 1, second: null } },
    { values: [[1], [null, 2]], expected: [1, null, 2] },
    { values: [{ discarded: 1 }, false, { retained: 2 }], expected: { retained: 2 } },
    { values: [{ discarded: 1 }, null], expected: null },
  ])(
    "merges protobuf Value payloads according to their active kind: $values",
    ({ values, expected }) => {
      const rawEvents = values.map((value) => field(3, Value.encode(Value.wrap(value)).finish()));
      expect(decode(stepWithBases(...rawEvents))).toMatchObject({ rawEvent: expected });
    },
  );

  it("merges a tool function split across message occurrences", () => {
    const fn = (value: { name?: string; arguments?: string }) =>
      field(3, types.ToolCall_Function.encode(types.ToolCall_Function.create(value)).finish());
    const tool = concat(
      types.ToolCall.encode(types.ToolCall.create({ id: "call", type: "function" })).finish(),
      fn({ name: "search" }),
      fn({ arguments: "{}" }),
    );
    const message = concat(
      types.Message.encode(types.Message.create({ id: "m", role: "assistant" })).finish(),
      field(5, tool),
    );
    const decoded = decode(
      field(
        9,
        field(
          1,
          events.BaseEvent.encode(
            events.BaseEvent.create({ type: events.EventType.MESSAGES_SNAPSHOT }),
          ).finish(),
        ),
        field(2, message),
      ),
    );
    expect(decoded).toMatchObject({
      messages: [
        {
          toolCalls: [
            {
              id: "call",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
      ],
    });
    expect(EventSchemas.parse(decoded)).toEqual(decoded);
  });
});
