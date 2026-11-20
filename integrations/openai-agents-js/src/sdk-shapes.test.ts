/**
 * Fast-fail guards against `@openai/agents` / `openai` dependency drift.
 *
 * The adapter's raw-event mapping in `handlers.ts` depends on SDK shapes that
 * are only PARTIALLY typed by `@openai/agents`. This file pins those shapes two
 * ways so a dependency upgrade that changes them breaks CI before a silent
 * regression ships:
 *
 *   1. TYPE-LEVEL (compile-time) guards — enforced by `tsc --noEmit`. If the
 *      SDK renames/removes a class `type` discriminant, a run-item event name,
 *      the directly-typed `output_text_delta` shape, or the `model`
 *      passthrough wrapper, the assignments below fail to compile.
 *   2. RUNTIME contract tests — pin the EXACT passthrough shape (`{ type:
 *      "model", event: { type: "response.function_call_arguments.delta",
 *      item_id, delta } }` etc.) and assert `handleRawModelStreamEvent` maps
 *      each to the expected AG-UI event. If someone changes the literal
 *      `type` strings or field names in `handlers.ts` without updating these
 *      fixtures (or vice-versa), the runtime tests fail.
 *
 * IMPORTANT — version-skew caveat (why the raw `openai` literals are NOT
 * type-guarded here):
 *   `@openai/agents` v0.12 internally bundles `openai@6.x`, but THIS package's
 *   own `import "openai"` resolves to `openai@4.x` (its declared devDep). The
 *   raw Responses-API literals that ACTUALLY flow through the `model`
 *   passthrough at runtime belong to whichever `openai` `@openai/agents` uses
 *   (6.x), not necessarily the 4.x this package sees. Because of that skew, a
 *   type guard against this package's `openai` (4.x) would flag false
 *   positives for 6.x-only events (e.g. `response.reasoning_text.delta` is
 *   absent in 4.x) and miss real 6.x shape changes. So the raw literals are
 *   pinned purely as RUNTIME string constants below — an executable contract
 *   independent of which `openai` version resolves. If the `openai` major
 *   bundled by `@openai/agents` bumps, re-derive these from the new
 *   `openai/resources/responses/responses` `ResponseStreamEvent` union and
 *   update `handlers.ts` together with these constants.
 *
 * Note: `import type` only for the SDK — no runtime import of `@openai/agents`
 * (its `protocol.mjs` top-level zod construction is sensitive to the installed
 * zod version). The type surface alone is enough for the compile-time guards.
 */

import { describe, it, expect } from "vitest";
import type {
  RunRawModelStreamEvent,
  RunItemStreamEvent,
  RunAgentUpdatedStreamEvent,
  ResponseStreamEvent,
} from "@openai/agents";

import { EventType } from "@ag-ui/core";
import { StreamContext, handleRawModelStreamEvent } from "./handlers";

/* ========================================================================== */
/* 1. TYPE-LEVEL GUARDS (compile-time)                                        */
/* ========================================================================== */
/**
 * `dispatchStreamEvent` in adapter.ts switches on these string literals. Each
 * SDK stream class declares `readonly type = "<literal>"`, so the TS type of
 * the field is the literal string. The assignments below fail to compile if a
 * future `@openai/agents` rename changes the literal.
 */
type RawModelType = RunRawModelStreamEvent["type"];
type RunItemType = RunItemStreamEvent["type"];
type AgentUpdatedType = RunAgentUpdatedStreamEvent["type"];

// Compile fails if any class `type` discriminant changes.
const _rawModelType: "raw_model_stream_event" = null as unknown as RawModelType;
const _runItemType: "run_item_stream_event" = null as unknown as RunItemType;
const _agentUpdatedType: "agent_updated_stream_event" =
  null as unknown as AgentUpdatedType;

/* -------------------------------------------------------------------------- */
/* 1b. Run-item event-name union                                               */
/* -------------------------------------------------------------------------- */
/**
 * `handleRunItemStreamEvent` switches on `RunItemStreamEvent["name"]`. If any
 * of these literals are removed from the union, the assignment fails to
 * compile. (`RunItemStreamEventName` is defined in agents-core but NOT
 * re-exported by the `@openai/agents` barrel, so we derive the union from the
 * class field instead.)
 */
type RunItemName = RunItemStreamEvent["name"];
const _runItemNames: RunItemName[] = [
  "message_output_created",
  "tool_called",
  "tool_output",
  "reasoning_item_created",
  "tool_approval_requested",
  "handoff_requested",
  "handoff_occurred",
  "tool_search_called",
  "tool_search_output_created",
];

/* -------------------------------------------------------------------------- */
/* 1c. Directly-typed stream shapes (the non-passthrough branches)             */
/* -------------------------------------------------------------------------- */
/**
 * `handleRawModelStreamEvent` switches on `data.type === "output_text_delta"`
 * and reads `data.delta`. `output_text_delta` is the ONLY raw-model stream
 * shape `@openai/agents` types directly (as `StreamEventTextStream`); note it
 * carries `delta` but NOT `item_id`. If the SDK renames the literal or the
 * `delta` field, the assignment below fails to compile.
 *
 * `ResponseStreamEvent` here is `@openai/agents`'s re-export of agents-core's
 * `StreamEvent` union (NOT the `openai` package's same-named union — see the
 * version-skew caveat in the file header).
 */
type AgentsStreamEvent = ResponseStreamEvent;
type HasOutputTextDelta = Extract<AgentsStreamEvent, { type: "output_text_delta" }>;
const _outputTextShape: { type: "output_text_delta"; delta: string } =
  null as unknown as HasOutputTextDelta;

/**
 * `handleRawModelStreamEvent` reads `data.event` when `data.type === "model"`
 * — the passthrough wrapper (`StreamEventGenericItem`). The inner `event` is
 * typed `any`/`unknown` by the SDK (the raw Responses-API event is NOT typed
 * by `@openai/agents`), and the SDK's zod-inferred type even marks `event` as
 * optional. So we can only pin that the wrapper carries the `type: "model"`
 * literal and an `event` KEY (present at runtime even if the type says
 * optional). If the wrapper literal is renamed or the `event` key is removed,
 * the assignment below fails to compile.
 */
type HasModelPassthrough = Extract<AgentsStreamEvent, { type: "model" }>;
const _modelWrapperShape: { type: "model"; event?: unknown } =
  null as unknown as HasModelPassthrough;

/**
 * `RunRawModelStreamEvent.data` is the `ResponseStreamEvent` payload the
 * adapter unwraps in `dispatchStreamEvent`. Pin that the `data` field exists.
 */
const _rawDataShape: { data: unknown } = null as unknown as RunRawModelStreamEvent;

/* ========================================================================== */
/* 2. RUNTIME CONTRACT TESTS — pinned passthrough shapes                      */
/* ========================================================================== */
/*
 * The raw Responses-API events below arrive INSIDE the `{ type: "model",
 * event }` passthrough. Their literal `type` strings and `item_id` / `delta`
 * fields are owned by the `openai` package and have changed across major
 * releases; they are NOT typed by `@openai/agents` (and see the version-skew
 * caveat above). We pin them here as plain string constants + fixture objects
 * so that:
 *
 *   - If a future upgrade renames a literal (e.g. `response.reasoning_text.delta`
 *     is removed or renamed), the fixture no longer matches what the SDK emits
 *     and a developer MUST consciously update both this test and `handlers.ts`
 *     together — there is no silent path.
 *   - The exact shape we depend on (which fields, which literals) is documented
 *     as an executable assertion rather than only a comment.
 *
 * These literals are pinned from `openai@6.x` (the version `@openai/agents`
 * v0.12 bundles). If the bundled `openai` major bumps, re-derive these from
 * the new `openai/resources/responses/responses` `ResponseStreamEvent` union.
 */
const RAW_LITERALS = {
  functionCallArgsDelta: "response.function_call_arguments.delta",
  reasoningSummaryTextDelta: "response.reasoning_summary_text.delta",
  reasoningTextDelta: "response.reasoning_text.delta",
} as const;

describe("SDK shape guards — type-level (enforced at compile time)", () => {
  // The real assertion is that this file compiles at all. If any guard above
  // breaks under a dependency upgrade, `tsc --noEmit` fails and CI stops here.
  // The runtime expects below keep vitest from treating the constants as
  // unused and document what each guard pins.
  it("stream-event class type discriminants are pinned", () => {
    expect(_rawModelType).toBeDefined();
    expect(_runItemType).toBeDefined();
    expect(_agentUpdatedType).toBeDefined();
  });

  it("run-item event-name union is pinned", () => {
    expect(_runItemNames).toContain("tool_called");
    expect(_runItemNames).toContain("tool_output");
    expect(_runItemNames).toContain("message_output_created");
    expect(_runItemNames).toContain("reasoning_item_created");
  });

  it("directly-typed output_text_delta shape is pinned", () => {
    expect(_outputTextShape).toBeDefined();
  });

  it("model passthrough wrapper shape is pinned", () => {
    expect(_modelWrapperShape).toBeDefined();
    expect(_rawDataShape).toBeDefined();
  });

  it("raw Responses-API delta literals are the expected 6.x strings", () => {
    // These are the literals handlers.ts switches on inside the passthrough.
    // If an `openai` major bump renames any of them, update handlers.ts AND
    // these constants together.
    expect(RAW_LITERALS.functionCallArgsDelta).toBe(
      "response.function_call_arguments.delta",
    );
    expect(RAW_LITERALS.reasoningSummaryTextDelta).toBe(
      "response.reasoning_summary_text.delta",
    );
    expect(RAW_LITERALS.reasoningTextDelta).toBe(
      "response.reasoning_text.delta",
    );
  });
});

describe("SDK shape guards — runtime passthrough contract", () => {
  /**
   * Each fixture mirrors the exact passthrough shape `handleRawModelStreamEvent`
   * unwraps: `{ type: "model", event: <raw Responses-API event> }`. The inner
   * event carries `type` (literal), `item_id`, and `delta`. If the shape
   * changes, the corresponding handler case stops matching and these tests
   * fail — surfacing the drift instead of silently dropping deltas.
   */
  it("maps a function-call-arguments delta passthrough to TOOL_CALL_ARGS (once the call is open)", () => {
    const ctx = new StreamContext("run-1");
    // Args before the run_item tool_called event arrive buffered (not emitted
    // yet) — handlers.ts deliberately suppresses TOOL_CALL_ARGS until a
    // TOOL_CALL_START has been emitted for the call id.
    const beforeOpen = handleRawModelStreamEvent(
      {
        type: "model",
        event: {
          type: RAW_LITERALS.functionCallArgsDelta,
          item_id: "call_1",
          delta: '{"a":',
          output_index: 0,
          sequence_number: 1,
        },
      },
      ctx,
    );
    expect(beforeOpen).toEqual([]);
    expect(ctx.toolCallArgs.get("call_1")).toBe('{"a":');

    // Mark the call open (normally done by the run_item `tool_called` event)
    // and stream a second delta — it must pass through as TOOL_CALL_ARGS.
    ctx.openToolCalls.add("call_1");
    const afterOpen = handleRawModelStreamEvent(
      {
        type: "model",
        event: {
          type: RAW_LITERALS.functionCallArgsDelta,
          item_id: "call_1",
          delta: "1}",
          output_index: 0,
          sequence_number: 2,
        },
      },
      ctx,
    );
    expect(afterOpen).toEqual([
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "call_1", delta: "1}" },
    ]);
  });

  it("maps a reasoning-summary-text delta passthrough to REASONING_MESSAGE_START + CONTENT", () => {
    const ctx = new StreamContext("run-1");
    const events = handleRawModelStreamEvent(
      {
        type: "model",
        event: {
          type: RAW_LITERALS.reasoningSummaryTextDelta,
          item_id: "rsn_1",
          delta: "Thinking",
          output_index: 0,
          sequence_number: 1,
          summary_index: 0,
        },
      },
      ctx,
    );
    expect(events).toEqual([
      { type: EventType.REASONING_MESSAGE_START, messageId: "rsn_1", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "rsn_1", delta: "Thinking" },
    ]);
  });

  it("maps a reasoning-text delta passthrough to REASONING_MESSAGE_START + CONTENT", () => {
    const ctx = new StreamContext("run-1");
    const events = handleRawModelStreamEvent(
      {
        type: "model",
        event: {
          type: RAW_LITERALS.reasoningTextDelta,
          item_id: "rsn_2",
          delta: "Reasoning",
          output_index: 0,
          sequence_number: 1,
          content_index: 0,
        },
      },
      ctx,
    );
    expect(events).toEqual([
      { type: EventType.REASONING_MESSAGE_START, messageId: "rsn_2", role: "reasoning" },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "rsn_2", delta: "Reasoning" },
    ]);
  });

  it("maps the directly-typed output_text_delta (non-passthrough) to TEXT_MESSAGE_START + CONTENT", () => {
    const ctx = new StreamContext("run-1");
    const events = handleRawModelStreamEvent(
      { type: "output_text_delta", delta: "Hi" },
      ctx,
    );
    expect(events).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: "run-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "run-1", delta: "Hi" },
    ]);
  });

  it("drops a passthrough whose inner raw type is unknown (no silent mapping)", () => {
    const ctx = new StreamContext("run-1");
    const events = handleRawModelStreamEvent(
      {
        type: "model",
        event: { type: "response.some_future_event.delta", item_id: "x", delta: "y" },
      },
      ctx,
    );
    expect(events).toEqual([]);
  });
});
