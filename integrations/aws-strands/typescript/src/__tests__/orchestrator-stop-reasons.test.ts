/**
 * Abnormal stop reasons on the orchestrator path (Graph/Swarm).
 *
 * The orchestrator counterpart of `stop-reasons.test.ts`. One adapter must not
 * report the same provider failure under two different codes depending on
 * whether the caller wired an `Agent` or a `Graph`/`Swarm`: Python has no
 * separate orchestrator loop, so its `force_stop` handling and its
 * `AgentStopped` hint already cover multi-agent runs, and the TypeScript
 * orchestrator has to spell both the same way.
 *
 * The hint arrives differently on this path. A `Graph` never puts a stop reason
 * on its own terminal `MultiAgentResult`; the per-node stop reason rides an
 * `agentResultEvent` nested inside `nodeStreamUpdateEvent.inner`, because
 * `AgentNode.handle` forwards every event the wrapped `Agent.stream()` yields.
 * Every assertion here pins the wire payload rather than the branch that
 * produced it.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentResult,
  AgentResultEvent,
  MaxTokensError,
  Message,
  ModelThrottledError,
  StructuredOutputError,
  TextBlock,
} from "@strands-agents/sdk";
import type { StopReason } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";

const FORCE_STOP_FALLBACK = "The Strands agent stopped unexpectedly.";

type RunError = { type: string; code?: string; message?: string };
type CustomEvent = { type: string; name?: string; value?: unknown };

/**
 * Orchestrator stub: exposes `.stream()` but no `.model` accessor, which is how
 * the adapter discriminates a Graph/Swarm from an Agent. Yields `events`, then
 * throws the failure if one was passed.
 *
 * The failure is a rest parameter rather than an optional one so that "no
 * failure" and "throws `undefined`" are different calls. An optional parameter
 * makes `undefined` mean both, which leaves the single-agent suite's thrown
 * `undefined` with no counterpart here: the value a run can genuinely be
 * killed by is the same value that says nothing killed it.
 */
function orchestratorThrowingAfter(
  events: unknown[],
  ...failure: [] | [unknown]
) {
  const throws = failure.length > 0;
  const error = failure[0];
  const stub = {
    id: "test-graph",
    async *stream(_input: string) {
      for (const e of events) yield e;
      if (throws) throw error;
    },
  };
  return new StrandsAgent({
    agent: stub as unknown as import("@strands-agents/sdk").Agent,
    name: "orch",
  });
}

/**
 * Orchestrator stub whose stream ends by RETURNING `result`.
 *
 * `Graph.stream()` and `Swarm.stream()` return the aggregate `MultiAgentResult`
 * on `{ done: true }` (`multiagent/graph.js`, `multiagent/swarm.js`), which is
 * where the run's terminal status lives.
 */
function orchestratorReturning(events: unknown[], result: unknown) {
  const stub = {
    id: "test-graph",
    async *stream(_input: string) {
      for (const e of events) yield e;
      return result;
    },
  };
  return new StrandsAgent({
    agent: stub as unknown as import("@strands-agents/sdk").Agent,
    name: "orch",
  });
}

/**
 * An aggregate `MultiAgentResult`, in the shape `multiagent/state.d.ts` gives
 * it. `Graph` and `Swarm` never pass `status` themselves; it is derived from
 * the node results, so a stub states the derived value directly.
 */
function multiAgentResult(
  status: string,
  results: Array<Record<string, unknown>> = [],
  aggregateError?: unknown,
) {
  return {
    type: "multiAgentResult",
    status,
    results,
    content: [],
    duration: 3,
    usage: {},
    ...(aggregateError !== undefined ? { error: aggregateError } : {}),
  };
}

/** One entry of `MultiAgentResult.results`. */
function nodeResult(
  nodeId: string,
  status: string,
  error?: unknown,
): Record<string, unknown> {
  return {
    type: "nodeResult",
    nodeId,
    status,
    duration: 1,
    content: [],
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * A node's `BeforeNodeCallEvent`, carrying the fields the real event carries.
 *
 * Neither `BeforeNodeCallEvent` nor `AfterNodeCallEvent` has a `nodeType`
 * (`@strands-agents/sdk`, `dist/src/multiagent/events.js`): they carry
 * `orchestrator`, `state`, `nodeId`, `invocationState` and, respectively,
 * `cancel` and `error`. `_stepName`'s `nodeType` fallback is therefore the arm
 * production always takes, and a stub that supplied one would pin a step name
 * no real run can emit.
 */
function beforeNodeCall(nodeId: string) {
  return {
    type: "beforeNodeCallEvent",
    orchestrator: { id: "test-graph" },
    state: {},
    nodeId,
    invocationState: { userId: "u-1" },
    cancel: false,
  };
}

/** A node's `AfterNodeCallEvent`, which closes the node's step envelope. */
function afterNodeCall(nodeId: string) {
  return {
    type: "afterNodeCallEvent",
    orchestrator: { id: "test-graph" },
    state: {},
    nodeId,
    invocationState: { userId: "u-1" },
  };
}

/** A node-level text delta, as `AgentNode` wraps it on the orchestrator path. */
function nodeTextDelta(text: string, nodeId = "writer") {
  return {
    type: "nodeStreamUpdateEvent",
    nodeId,
    nodeType: "agentNode",
    inner: {
      source: "agent",
      event: {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text },
      },
    },
  };
}

/** A node-level reasoning delta. */
function nodeReasoningDelta(text: string) {
  return {
    type: "nodeStreamUpdateEvent",
    nodeId: "writer",
    nodeType: "agentNode",
    inner: {
      source: "agent",
      event: {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "reasoningContentDelta", text },
      },
    },
  };
}

/**
 * A node's terminal `AgentResultEvent`, as `AgentNode.handle` forwards it:
 * `Agent.stream()` yields the event, and the node wraps every yielded event in
 * a `NodeStreamUpdateEvent` tagged `source: 'agent'`.
 *
 * The inner event is the SDK's own class, so the `result` nesting the adapter
 * reaches through is the SDK's shape rather than this file's opinion of it.
 * `agent` is a `LocalAgent` nothing on this path dereferences, so a stub stands
 * in for one. `stopReason` is widened deliberately: `StopReason` is a union in
 * the type system but `string` at runtime, and the rows below drive provider
 * spellings and inherited object keys the union does not carry.
 */
function nodeAgentResult(stopReason: string, nodeId = "writer") {
  return {
    type: "nodeStreamUpdateEvent",
    nodeId,
    nodeType: "agentNode",
    inner: {
      source: "agent",
      event: new AgentResultEvent({
        agent: { name: nodeId, model: { modelId: "stub-model" } } as never,
        result: new AgentResult({
          stopReason: stopReason as StopReason,
          lastMessage: new Message({
            role: "assistant",
            content: [new TextBlock("done")],
          }),
          invocationState: { userId: "u-1" },
        }),
        invocationState: { userId: "u-1" },
      }),
    },
  };
}

function agentStoppedEvents(events: BaseEvent[]): CustomEvent[] {
  return (events as unknown as CustomEvent[]).filter(
    (e) => e.type === EventType.CUSTOM && e.name === "AgentStopped",
  );
}

/**
 * Position of the `AgentStopped` hint on the wire, or -1 when it never arrived.
 *
 * Located by name, never by event type: this path also emits `MultiAgentHandoff`
 * as a CUSTOM event and the single-agent path emits `PredictState`, so an index
 * taken from the type alone is satisfied by an unrelated custom event.
 */
function agentStoppedIndex(events: BaseEvent[]): number {
  return (events as unknown as CustomEvent[]).findIndex(
    (e) => e.type === EventType.CUSTOM && e.name === "AgentStopped",
  );
}

function runError(events: BaseEvent[]): RunError | undefined {
  return (events as unknown as RunError[]).find(
    (e) => e.type === EventType.RUN_ERROR,
  );
}

/** One captured default-logger line, with the arguments it was handed intact. */
type LogLine = { level: "warn" | "error"; args: unknown[] };

/**
 * Run with the default logger's console sinks captured.
 *
 * `DEFAULT_LOGGER.debug` is a no-op, so a trace that only reaches `debug`
 * produces no line here. That is the point: these tests assert what an
 * operator running the adapter with no injected logger actually sees.
 *
 * The arguments are kept unstringified so a test can assert that the failure
 * OBJECT reached the log, not merely its message text.
 */
async function collectWithLogs(
  agent: StrandsAgent,
  input?: RunAgentInput,
): Promise<{ events: BaseEvent[]; logs: LogLine[] }> {
  const logs: LogLine[] = [];
  const warn = vi
    .spyOn(console, "warn")
    .mockImplementation((...args: unknown[]) => {
      logs.push({ level: "warn", args });
    });
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      logs.push({ level: "error", args });
    });
  try {
    return { events: await collect(agent, input ?? minimalRunInput()), logs };
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

/** Run with `console.error` silenced, returning the events and the logged lines. */
async function collectQuietly(
  agent: StrandsAgent,
): Promise<{ events: BaseEvent[]; logged: string[] }> {
  const { events, logs } = await collectWithLogs(agent);
  return {
    events,
    logged: logs
      .filter((line) => line.level === "error")
      .map((line) => line.args.map((a) => String(a)).join(" ")),
  };
}

/** The line whose arguments include `value` by identity, if any. */
function lineCarrying(logs: LogLine[], value: unknown): LogLine | undefined {
  return logs.find((line) => line.args.some((arg) => arg === value));
}

/** Every line whose stringified arguments mention `needle`. */
function linesMentioning(logs: LogLine[], needle: string): LogLine[] {
  return logs.filter((line) =>
    line.args
      .map((a) => String(a))
      .join(" ")
      .includes(needle),
  );
}

/**
 * Every string reachable from `value`, including the ones `JSON.stringify`
 * cannot see.
 *
 * `Error.name`, `Error.message` and `Error.stack` are all non-enumerable, so an
 * event carrying a live `Error` serializes to `{}` and a `not.toContain` check
 * over `JSON.stringify(events)` can never fail however completely the adapter
 * leaks it. This walks the object graph itself and reads those three off any
 * `Error` it meets, plus the `cause` chain, so a leaked failure is observable.
 */
function reachableStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(value.name, value.message);
    if (typeof value.stack === "string") out.push(value.stack);
    out.push(...reachableStrings(value.cause, seen));
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    out.push(...reachableStrings(entry, seen));
  }
  return out;
}

/** True when any string reachable from `value` mentions `needle`. */
function mentions(value: unknown, needle: string): boolean {
  return reachableStrings(value).some((s) => s.includes(needle));
}

/** The `stepName` of every event of `kind`, in wire order. */
function stepNames(events: BaseEvent[], kind: EventType): string[] {
  return (events as unknown as Array<{ type: string; stepName?: string }>)
    .filter((e) => e.type === kind)
    .map((e) => e.stepName as string);
}

describe("orchestrator forced stop", () => {
  it("reports the underlying reason under the forced-stop code, not STRANDS_ERROR", async () => {
    // The single-agent path reports a provider failure as STRANDS_FORCE_STOP.
    // A Graph run must not report the same failure as STRANDS_ERROR.
    const agent = orchestratorThrowingAfter([], new Error("Too many requests"));

    const { events, logged } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
    expect(logged.some((line) => line.includes("Too many requests"))).toBe(
      true,
    );
  });

  it("falls back to Python's message when the failure carries no reason", async () => {
    const agent = orchestratorThrowingAfter([], new Error("   "));

    const { events } = await collectQuietly(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
  });

  it("closes an open text message before the terminal error", async () => {
    // A client that saw TEXT_MESSAGE_START must not be left holding the
    // envelope open when the run ends in RUN_ERROR.
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("partial answ")],
      new Error("provider throttled"),
    );

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const startAt = kinds.indexOf(EventType.TEXT_MESSAGE_START);
    const endAt = kinds.indexOf(EventType.TEXT_MESSAGE_END);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    // Present, not merely "not after": indexOf returns -1 for an event that
    // never reached the wire, which an ordering check alone would accept.
    expect(startAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(endAt).toBeLessThan(errorAt);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
    expect(runError(events)?.code).toBe("STRANDS_FORCE_STOP");
  });

  it("closes an open reasoning message before the terminal error", async () => {
    const agent = orchestratorThrowingAfter(
      [nodeReasoningDelta("thinking abo")],
      new Error("provider throttled"),
    );

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const startAt = kinds.indexOf(EventType.REASONING_MESSAGE_START);
    const messageEndAt = kinds.indexOf(EventType.REASONING_MESSAGE_END);
    const reasoningEndAt = kinds.indexOf(EventType.REASONING_END);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(startAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeGreaterThan(-1);
    expect(reasoningEndAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeLessThan(errorAt);
    expect(reasoningEndAt).toBeLessThan(errorAt);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("does not advertise a state snapshot or finish after a forced stop", async () => {
    // A forced stop is a failed run, not a short success.
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("partial")],
      new Error("provider throttled"),
    );

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(errorAt).toBeGreaterThan(-1);
    expect(kinds.slice(errorAt)).toEqual([EventType.RUN_ERROR]);
  });

  it("skips the final state snapshot a successful run ends with", async () => {
    // Compared against the same script finishing normally, so the count is
    // pinned by the contrast rather than by a comment about which snapshot the
    // initial one is.
    const failing = orchestratorThrowingAfter(
      [nodeTextDelta("partial")],
      new Error("provider throttled"),
    );
    const succeeding = orchestratorThrowingAfter([nodeTextDelta("partial")]);

    const { events: failedEvents } = await collectQuietly(failing);
    const okEvents = await collect(succeeding);

    const snapshotsIn = (events: BaseEvent[]) =>
      events.filter((e) => e.type === EventType.STATE_SNAPSHOT).length;
    expect(snapshotsIn(okEvents)).toBe(2);
    expect(snapshotsIn(failedEvents)).toBe(1);
  });

  it("reports the failure exactly once and never twice", async () => {
    // One failure is one RUN_ERROR. A second report, from the outer handler or
    // from a rethrow, would leave a client unable to tell one failed run from
    // two.
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("partial")],
      new Error("provider throttled"),
    );

    const { events } = await collectQuietly(agent);

    expect(events.filter((e) => e.type === EventType.RUN_ERROR)).toHaveLength(
      1,
    );
  });

  it("keeps an adapter code defect out of the forced-stop code", async () => {
    // TypeError/ReferenceError mean the adapter is broken, not that the
    // provider failed, so they keep their own classification.
    const agent = orchestratorThrowingAfter(
      [],
      new TypeError("cannot read 'x'"),
    );

    const { events } = await collectQuietly(agent);

    expect(runError(events)?.code).toBe("ADAPTER_BUG");
    expect(agentStoppedEvents(events)).toEqual([]);
  });

  it("keeps a ReferenceError out of the forced-stop code", async () => {
    const agent = orchestratorThrowingAfter(
      [],
      new ReferenceError("x is not defined"),
    );

    const { events } = await collectQuietly(agent);

    expect(runError(events)?.code).toBe("ADAPTER_BUG");
  });
});

describe("orchestrator abnormal stop reasons", () => {
  // Every key the adapter's table carries, both spellings of each reason. A key
  // that is never driven is a key whose value nothing pins, and the two
  // spellings do not share a code path: each is its own entry.
  it.each([
    ["guardrailIntervened", "guardrail_intervened"],
    ["contentFiltered", "content_filtered"],
    ["maxTokens", "max_tokens"],
    // `StopReason` widens to `string`, so a model that forwards the provider
    // spelling instead of the SDK's camelCase is recognised too.
    ["guardrail_intervened", "guardrail_intervened"],
    ["content_filtered", "content_filtered"],
    ["max_tokens", "max_tokens"],
  ])(
    "announces %s from a node's terminal result and still finishes the run",
    async (stopReason, expected) => {
      const agent = orchestratorThrowingAfter([
        beforeNodeCall("writer"),
        nodeTextDelta("short"),
        nodeAgentResult(stopReason),
        afterNodeCall("writer"),
      ]);

      // An abnormal stop warns by design; the warn itself is asserted under
      // "orchestrator diagnostics", so it is captured here rather than left on
      // stderr.
      const { events } = await collectWithLogs(agent);

      expect(agentStoppedEvents(events)).toEqual([
        {
          type: EventType.CUSTOM,
          name: "AgentStopped",
          value: { stop_reason: expected },
        },
      ]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
      expect(kinds).not.toContain(EventType.RUN_ERROR);
    },
  );

  it.each(["endTurn", "toolUse", "stopSequence", "interrupt"])(
    "stays silent for the normal stop %s",
    async (stopReason) => {
      const agent = orchestratorThrowingAfter([
        nodeTextDelta("done"),
        nodeAgentResult(stopReason),
      ]);

      const events = await collect(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    },
  );

  it("stays silent when a node's terminal result carries no stop reason", async () => {
    const agent = orchestratorThrowingAfter([
      {
        type: "nodeStreamUpdateEvent",
        inner: { source: "agent", event: { type: "agentResultEvent" } },
      },
    ]);

    const events = await collect(agent);

    expect(agentStoppedEvents(events)).toEqual([]);
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("announces one hint per node in a multi-node run", async () => {
    // A Graph runs several nodes, each with its own terminal result. Every
    // abnormal stop gets its own hint so a client can attribute the outcome.
    //
    // Each node is bracketed by its own before/after pair, which is the only
    // shape the SDK emits: `AfterNodeCallEvent` is fired by the same call that
    // fired `BeforeNodeCallEvent`, so a script with an after and no before
    // produces a STEP_FINISHED that no real run can, and one the AG-UI client
    // verifier rejects outright.
    const agent = orchestratorThrowingAfter([
      beforeNodeCall("writer"),
      nodeTextDelta("first"),
      nodeAgentResult("contentFiltered"),
      afterNodeCall("writer"),
      beforeNodeCall("editor"),
      nodeTextDelta("second", "editor"),
      nodeAgentResult("endTurn", "editor"),
      afterNodeCall("editor"),
      beforeNodeCall("reviewer"),
      nodeTextDelta("third", "reviewer"),
      nodeAgentResult("maxTokens", "reviewer"),
      afterNodeCall("reviewer"),
    ]);

    const { events } = await collectWithLogs(agent);

    expect(
      agentStoppedEvents(events).map(
        (e) => (e.value as { stop_reason: string }).stop_reason,
      ),
    ).toEqual(["content_filtered", "max_tokens"]);
    // Every step the script opened was closed, which is what makes it a script
    // the SDK could have produced and a run the AG-UI verifier would accept.
    expect(stepNames(events, EventType.STEP_STARTED)).toEqual([
      "agent:writer",
      "agent:editor",
      "agent:reviewer",
    ]);
    expect(stepNames(events, EventType.STEP_FINISHED)).toEqual([
      "agent:writer",
      "agent:editor",
      "agent:reviewer",
    ]);
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("announces one hint per abnormal terminal result, once each", async () => {
    // The same node reporting the same abnormal stop twice gets two hints, one
    // per result: the hint describes a result, not a run.
    const agent = orchestratorThrowingAfter([
      nodeTextDelta("first"),
      nodeAgentResult("contentFiltered"),
      nodeTextDelta("second"),
      nodeAgentResult("contentFiltered"),
    ]);

    const { events } = await collectWithLogs(agent);

    expect(agentStoppedEvents(events)).toEqual([
      {
        type: EventType.CUSTOM,
        name: "AgentStopped",
        value: { stop_reason: "content_filtered" },
      },
      {
        type: EventType.CUSTOM,
        name: "AgentStopped",
        value: { stop_reason: "content_filtered" },
      },
    ]);
  });

  it("announces the hint before the terminal error when both happen", async () => {
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("short"), nodeAgentResult("contentFiltered")],
      new Error("provider throttled"),
    );

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const hintAt = agentStoppedIndex(events);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(hintAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(-1);
    expect(hintAt).toBeLessThan(errorAt);
    expect(runError(events)?.code).toBe("STRANDS_FORCE_STOP");
  });
});

describe("orchestrator inherited object keys are not stop reasons", () => {
  it.each([
    "toString",
    "constructor",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])(
    "stays silent when a node's terminal stop reason is the inherited key %s",
    async (stopReason) => {
      // This path reads the same abnormal-reason table as the single-agent one,
      // so it inherits the same exposure: `StopReason` widens to `string`, a
      // provider value reaches the table verbatim, and a table looked up
      // through the prototype chain answers these keys with an inherited
      // function or object. That passes a truthiness guard and puts a
      // `stop_reason` that is not a stop reason on the wire.
      const agent = orchestratorThrowingAfter([
        nodeTextDelta("hi"),
        nodeAgentResult(stopReason),
      ]);

      const events = await collect(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
    },
  );
});

/**
 * A `MaxTokensError` raised by a SECOND copy of the SDK in the dependency tree.
 *
 * Carries the `name` the SDK's own constructor sets, and is not an
 * `instanceof` the class this file imports. That combination is the whole
 * reason the bypass matches on `Error.name`: a peer dependency resolved twice,
 * from two version ranges or from a workspace link sitting next to a registry
 * install, produces two unrelated classes for one error, and `instanceof`
 * answers false for the copy the adapter did not import. A list built only from
 * real SDK instances cannot tell the two matching strategies apart, and the
 * reporter both paths share is where that choice lives.
 */
class DuplicatedSdkMaxTokensError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaxTokensError";
  }
}

/**
 * The failures Python raises AFTER its model call returned normally.
 *
 * `event_loop_cycle` re-raises `MaxTokensReachedException` and
 * `StructuredOutputException` without yielding a `ForceStopEvent`, so its
 * adapter reports them from the outer handler as STRANDS_ERROR. The
 * single-agent path here mirrors that; one adapter cannot report the same
 * failure under a different code because the caller wired a Graph.
 */
const bypassingFailures: [string, Error][] = [
  [
    "MaxTokensError",
    new MaxTokensError(
      "Model reached maximum token limit. This is an unrecoverable state that requires intervention.",
      new Message({ role: "assistant", content: [new TextBlock("partial")] }),
    ),
  ],
  [
    "StructuredOutputError",
    new StructuredOutputError(
      "The model failed to invoke the structured output tool even after it was forced.",
    ),
  ],
  [
    "MaxTokensError from a duplicated SDK copy",
    new DuplicatedSdkMaxTokensError(
      "Model reached maximum token limit. This is an unrecoverable state that requires intervention.",
    ),
  ],
];

describe("orchestrator: where the failure was raised decides the code", () => {
  it.each(bypassingFailures)(
    "reports a thrown %s as a stream error, not a forced stop",
    async (_name, failure) => {
      const agent = orchestratorThrowingAfter(
        [nodeTextDelta("partial")],
        failure,
      );

      const { events } = await collectQuietly(agent);

      expect(runError(events)).toMatchObject({
        code: "STRANDS_ERROR",
        message: failure.message,
      });
      const kinds = events.map((e) => e.type);
      expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
      expect(kinds).not.toContain(EventType.RUN_FINISHED);
    },
  );

  it("reports a thrown ModelThrottledError as the forced stop", async () => {
    // The contrast case: a failure raised from inside the model call keeps the
    // forced-stop code on this path too.
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("partial")],
      new ModelThrottledError("Too many requests"),
    );

    const { events } = await collectQuietly(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
  });

  it.each(bypassingFailures)(
    "closes an open text message before a thrown %s is reported",
    async (_name, failure) => {
      // The bypass hands the run to the outer handler, but a client that saw
      // TEXT_MESSAGE_START must not be left holding the envelope open ahead of
      // RUN_ERROR. The single-agent path deliberately keeps Python's bare
      // reraise here; this path has no Python counterpart to match.
      const agent = orchestratorThrowingAfter(
        [nodeTextDelta("partial answ")],
        failure,
      );

      const { events } = await collectQuietly(agent);

      const kinds = events.map((e) => e.type);
      const startAt = kinds.indexOf(EventType.TEXT_MESSAGE_START);
      const endAt = kinds.indexOf(EventType.TEXT_MESSAGE_END);
      const errorAt = kinds.indexOf(EventType.RUN_ERROR);
      expect(startAt).toBeGreaterThan(-1);
      expect(endAt).toBeGreaterThan(-1);
      expect(errorAt).toBeGreaterThan(-1);
      expect(endAt).toBeLessThan(errorAt);
      expect(runError(events)?.code).toBe("STRANDS_ERROR");
    },
  );

  it("closes an open text message before an adapter defect is reported", async () => {
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("partial answ")],
      new TypeError("cannot read 'x'"),
    );

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const endAt = kinds.indexOf(EventType.TEXT_MESSAGE_END);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(kinds.indexOf(EventType.TEXT_MESSAGE_START)).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(-1);
    expect(endAt).toBeLessThan(errorAt);
    expect(runError(events)?.code).toBe("ADAPTER_BUG");
  });

  it("closes an open reasoning message before a bypassed failure is reported", async () => {
    const agent = orchestratorThrowingAfter(
      [nodeReasoningDelta("thinking abo")],
      new StructuredOutputError("forced tool never invoked"),
    );

    const { events } = await collectQuietly(agent);

    const kinds = events.map((e) => e.type);
    const messageEndAt = kinds.indexOf(EventType.REASONING_MESSAGE_END);
    const reasoningEndAt = kinds.indexOf(EventType.REASONING_END);
    const errorAt = kinds.indexOf(EventType.RUN_ERROR);
    expect(kinds.indexOf(EventType.REASONING_MESSAGE_START)).toBeGreaterThan(
      -1,
    );
    expect(messageEndAt).toBeGreaterThan(-1);
    expect(reasoningEndAt).toBeGreaterThan(-1);
    expect(messageEndAt).toBeLessThan(errorAt);
    expect(reasoningEndAt).toBeLessThan(errorAt);
    expect(runError(events)?.code).toBe("STRANDS_ERROR");
  });

  it.each(bypassingFailures)(
    "invents no stop-reason hint for a thrown %s",
    async (_name, failure) => {
      const agent = orchestratorThrowingAfter([], failure);

      const { events } = await collectQuietly(agent);

      expect(agentStoppedEvents(events)).toEqual([]);
    },
  );
});

/**
 * The aggregate `MultiAgentResult` a Graph or Swarm returns on `{ done: true }`
 * is not read, so its terminal status changes nothing on the wire.
 *
 * That leaves a fully failed Graph reporting as a finished run. It is a real
 * bug and it is deliberately not fixed here, but not because the adapter is
 * blind to node failures: `AfterNodeCallEvent.error` and
 * `NodeResultEvent.result.error` (`multiagent/events.d.ts`) both reach the
 * consume loop and are discarded as well. What was judged unusable is the
 * aggregate STATUS specifically, because `_resolveStatus`
 * (`multiagent/state.js`) marks the aggregate FAILED when ANY node failed, so a
 * Graph that lost one parallel branch and answered from another is FAILED too
 * and acting on that status would fail runs that succeeded. What a failed Graph
 * run owes a client, and which of the available signals should say it, is a
 * design question of its own. These tests pin what the adapter does today, so
 * that answering it later is a visible change rather than a silent one.
 */
describe("orchestrator terminal aggregate status", () => {
  it.each([
    ["COMPLETED", [nodeResult("writer", "COMPLETED")]],
    ["CANCELLED", [nodeResult("writer", "CANCELLED")]],
    ["FAILED", [nodeResult("flaky", "FAILED", new Error("provider exploded"))]],
  ])("finishes the run on a %s aggregate", async (status, results) => {
    const agent = orchestratorReturning(
      [nodeTextDelta("partial")],
      multiAgentResult(status, results),
    );

    const events = await collect(agent);

    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("puts no error on the wire for a FAILED aggregate", async () => {
    // Not merely "the run finished": nothing about the aggregate reaches the
    // client at all, so a frontend has no failure to render either.
    //
    // Asserted over the reachable strings rather than over
    // `JSON.stringify(events)`. The failure the aggregate carries is an
    // `Error`, whose `message` is non-enumerable, so forwarding the whole
    // aggregate verbatim would serialize that error to `{}` and satisfy a JSON
    // check while putting the failed run on the wire. The node id and the
    // aggregate status are asserted alongside it, because a leak that dropped
    // the error object would still be a leak.
    const agent = orchestratorReturning(
      [],
      multiAgentResult("FAILED", [
        nodeResult("flaky", "FAILED", new Error("provider exploded")),
      ]),
    );

    const events = await collect(agent);

    expect(mentions(events, "provider exploded")).toBe(false);
    expect(mentions(events, "flaky")).toBe(false);
    expect(mentions(events, "FAILED")).toBe(false);
    expect(agentStoppedEvents(events)).toEqual([]);
  });

  it("finishes normally when the stream returns nothing at all", async () => {
    // A custom `MultiAgent` implementation need not return a result, and an
    // absent one is not a failure.
    const agent = orchestratorReturning([nodeTextDelta("hi")], undefined);

    const events = await collect(agent);

    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_ERROR);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});

describe("orchestrator step envelopes", () => {
  it("leaves a step the SDK never closed open on a forced stop", async () => {
    // Step pairing follows the SDK's own node brackets and nothing else: a
    // `STEP_STARTED` whose `afterNodeCallEvent` never arrived stays open, on a
    // failed run exactly as on the healthy run that orchestrator-path.test.ts
    // pins for a hook-cancelled node.
    const agent = orchestratorThrowingAfter(
      [beforeNodeCall("writer")],
      new Error("provider throttled"),
    );

    const { events } = await collectQuietly(agent);

    expect(stepNames(events, EventType.STEP_STARTED)).toEqual(["agent:writer"]);
    expect(stepNames(events, EventType.STEP_FINISHED)).toEqual([]);
    const kinds = events.map((e) => e.type);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("adds no step event of its own when every node reported", async () => {
    const agent = orchestratorThrowingAfter(
      [beforeNodeCall("writer"), afterNodeCall("writer")],
      new Error("provider throttled"),
    );

    const { events } = await collectQuietly(agent);

    expect(stepNames(events, EventType.STEP_STARTED)).toEqual(["agent:writer"]);
    expect(stepNames(events, EventType.STEP_FINISHED)).toEqual([
      "agent:writer",
    ]);
  });
});

describe("orchestrator diagnostics", () => {
  it("resolves the thread id on the normal node-result trace too", async () => {
    // The normal stop only reaches `debug`, which `DEFAULT_LOGGER` drops, so
    // an injected logger is the only way to see the line an operator running
    // with debug wired up reads. Both arms print the same thread id.
    const debug = vi.fn();
    const stub = {
      id: "test-graph",
      async *stream(_input: string) {
        yield nodeTextDelta("done");
        yield nodeAgentResult("endTurn");
      },
    };
    const agent = new StrandsAgent({
      agent: stub as unknown as import("@strands-agents/sdk").Agent,
      name: "orch",
      config: { logger: { debug, warn: vi.fn(), error: vi.fn() } },
    });

    await collect(agent, minimalRunInput({ threadId: "" }));

    const lines = debug.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("node agent_result:"));
    expect(lines).toEqual([
      "[@ag-ui/aws-strands] node agent_result: threadId=default, " +
        "nodeId=writer, stopReason=endTurn",
    ]);
  });

  it("still reports the failure when the logger itself throws", async () => {
    // A caller-supplied `Logger` is arbitrary code, and a sink that stringifies
    // what it is handed throws on a circular `cause` without anything being
    // wrong with the run. On this path a throw escaping the report is caught as
    // the classification rethrow, which would discard the recorded provider
    // failure and report the logger's own error instead. The recorded reason
    // has to outlive a broken logger.
    const failure = new ModelThrottledError("Too many requests");
    const stub = {
      id: "test-graph",
      async *stream(_input: string) {
        yield nodeTextDelta("partial answ");
        throw failure;
      },
    };
    const agent = new StrandsAgent({
      agent: stub as unknown as import("@strands-agents/sdk").Agent,
      name: "orch",
      config: {
        logger: {
          debug: vi.fn(),
          warn: vi.fn(),
          error: () => {
            throw new TypeError("logger exploded");
          },
        },
      },
    });

    const events = await collect(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain(EventType.TEXT_MESSAGE_END);
    expect(kinds[kinds.length - 1]).toBe(EventType.RUN_ERROR);
  });

  it("hands the failure object to the forced-stop log, not just its text", async () => {
    // The outer handler this path diverts traffic away from logs
    // `error(prefix, e)`, which is what gives an operator the stack, the name
    // and the `cause`. Dropping to a template string loses all three.
    const failure = new ModelThrottledError("Too many requests", {
      cause: new Error("HTTP 429"),
    });
    const agent = orchestratorThrowingAfter([], failure);

    const { logs } = await collectWithLogs(agent);

    const line = lineCarrying(logs, failure);
    expect(line).toBeDefined();
    expect(line?.level).toBe("error");
  });

  it("resolves the thread id the log prints the way the adapter does", async () => {
    // `run()` resolves an empty thread id to "default" and every per-thread
    // lookup uses that value. Printing the raw input instead put a thread id
    // on the node terminal-result line that no other line in the adapter
    // agrees with, including the forced-stop line right next to it. Both lines
    // are driven, so the two cannot disagree.
    const agent = orchestratorThrowingAfter(
      [nodeTextDelta("blocked"), nodeAgentResult("guardrailIntervened")],
      new Error("provider throttled"),
    );

    const { logs } = await collectWithLogs(
      agent,
      minimalRunInput({ threadId: "" }),
    );

    expect(linesMentioning(logs, "node agent_result:")).toHaveLength(1);
    expect(linesMentioning(logs, "force-stopped")).toHaveLength(1);
    expect(linesMentioning(logs, "threadId=default")).toHaveLength(2);
    expect(linesMentioning(logs, "threadId=,")).toEqual([]);
  });

  it("logs an abnormal node stop where the default logger emits it", async () => {
    // `DEFAULT_LOGGER.debug` is a no-op, so a guardrail stop logged at debug
    // leaves no server trace at all.
    const agent = orchestratorThrowingAfter([
      nodeTextDelta("blocked"),
      nodeAgentResult("guardrailIntervened"),
    ]);

    const { events, logs } = await collectWithLogs(agent);

    expect(agentStoppedEvents(events)).toHaveLength(1);
    const lines = linesMentioning(logs, "guardrailIntervened");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.level === "warn")).toBe(true);
  });

  it("stays quiet on a normal node stop", async () => {
    const agent = orchestratorThrowingAfter([
      nodeTextDelta("done"),
      nodeAgentResult("endTurn"),
    ]);

    const { logs } = await collectWithLogs(agent);

    expect(logs).toEqual([]);
  });
});

describe("orchestrator failures that are not errors", () => {
  it("reports a failure whose name cannot be read as the forced stop", async () => {
    // Reading `name` can throw, from a getter that raises or a `Proxy` whose
    // `get` trap does. `_errorName` runs FIRST inside the report, ahead of the
    // classification and the message, so a throw escaping it reaches the outer
    // handler and reports a provider failure as `ADAPTER_BUG`. Pinned on both
    // paths because they share one reporter.
    const failure = new ModelThrottledError("Too many requests");
    Object.defineProperty(failure, "name", {
      get() {
        throw new TypeError("name accessor exploded");
      },
    });
    const agent = orchestratorThrowingAfter([], failure);

    // `collectWithLogs`, not `collectQuietly`: `Error.prototype.toString`
    // reads `name`, so stringifying this failure throws in the helper.
    const { events } = await collectWithLogs(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: "Too many requests",
    });
  });

  it("reports a thrown null under Python's fallback message", async () => {
    // `String(null)` is "null", which survives a trim and would otherwise be
    // put on the wire as the reason a run failed.
    const agent = orchestratorThrowingAfter([], null);

    const { events } = await collectQuietly(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
  });

  it("reports a thrown undefined under Python's fallback message", async () => {
    // The counterpart of the single-agent case. `undefined` is both a value a
    // run can be killed by and the value that says nothing killed it, so the
    // stub takes the failure as a rest parameter to keep the two apart.
    const agent = orchestratorThrowingAfter([], undefined);

    const { events } = await collectQuietly(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
    const kinds = events.map((e) => e.type);
    expect(kinds).not.toContain(EventType.RUN_FINISHED);
  });

  it("keeps a thrown string that happens to read 'null'", async () => {
    // A message someone wrote is not the absence of a message.
    const agent = orchestratorThrowingAfter([], "null");

    const { events } = await collectQuietly(agent);

    expect(runError(events)?.message).toBe("null");
  });

  it("falls back rather than failing on a value with no text at all", async () => {
    // `String()` on an object with a null prototype finds no `toString` and
    // throws a TypeError. Deriving the reason must not be able to fail: a
    // TypeError escaping the derivation reaches the outer handler, which
    // classifies it as an adapter code defect and reports a provider failure
    // as `ADAPTER_BUG`.
    const agent = orchestratorThrowingAfter([], Object.create(null));

    // `collectWithLogs`, not `collectQuietly`: the quiet helper stringifies
    // every logged argument, and this is the one value that cannot be
    // stringified.
    const { events } = await collectWithLogs(agent);

    expect(runError(events)).toMatchObject({
      code: "STRANDS_FORCE_STOP",
      message: FORCE_STOP_FALLBACK,
    });
  });
});
