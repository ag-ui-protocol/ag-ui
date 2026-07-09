# Subagent Backward-Compatibility Shim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a version-gated backward-compatibility middleware (`BackwardCompatibility_0_0_57`) that strips every subagent addition — the optional `subagentId` field and the `SUBAGENT_STARTED/FINISHED/ERROR` event types — in **both** directions when a modern client talks to a pre-subagent (≤ 0.0.57) remote agent: off input messages on the way *into* the agent, and off events (plus `MESSAGES_SNAPSHOT` messages) with the lifecycle events dropped entirely on the way *out*.

**Architecture:** A new `Middleware` subclass mirroring the existing `BackwardCompatibility_0_0_39` (input rewrite) and `BackwardCompatibility_0_0_45` (output `.pipe`) shims, auto-registered in the `AbstractAgent` constructor behind `compareVersions(this.maxVersion, "0.0.57") <= 0`. TypeScript client only (Python is producer-side and has no middleware layer).

**Tech Stack:** TypeScript, RxJS (`filter`/`map`), Zod (`@ag-ui/core` types), Vitest, `compare-versions`.

## Global Constraints

- **Version coupling (load-bearing):** the shim threshold is `"0.0.57"` (the last released version without subagents). The client `package.json` version MUST be bumped from `0.0.57` to `0.0.58` in the same change — otherwise a default client (`maxVersion === packageJson.version === "0.0.57"`) satisfies `compareVersions("0.0.57","0.0.57") <= 0` and would strip its own subagent data. Confirm the exact target version with the release owner before merge; `0.0.58` is the assumption throughout this plan.
- Mirror the existing shim conventions exactly: class name `BackwardCompatibility_0_0_57`, file `backward-compatibility-0-0-57.ts`, test under `src/middleware/__tests__/`, export from `middleware/index.ts`, register in `agent.ts` after the `0.0.47` block.
- The shim must not mutate its inputs in place — build new objects (spread), matching `sanitizeMessageContent` in `0.0.39`.
- TDD: failing test first, watch it fail, implement, watch it pass, commit.
- TS single-test command from `sdks/typescript`: `pnpm --filter @ag-ui/client test -- <relative-path>`.

## Scope note (what this shim does and does NOT do)

This is the standard AG-UI adapter for a **new client ↔ old agent**: it lets a subagent-aware client talk to a pre-subagent remote agent without leaking subagent constructs the old agent can't interpret. Input stripping (subagentId off message history the client replays to the old agent) is the substantive path; output stripping is defensive (a genuinely old agent won't emit `SUBAGENT_*`, but we strip symmetrically per the established pattern and to cover a mixed-version proxy). It does **not** retroactively make a genuinely-old *consumer* tolerate `SUBAGENT_*` events from a new producer — that consumer predates this shim; cross-version producer→consumer safety remains a version-negotiation concern, exactly as for every prior new event type.

## File Structure

- Create: `sdks/typescript/packages/client/src/middleware/backward-compatibility-0-0-57.ts` — the shim.
- Create: `sdks/typescript/packages/client/src/middleware/__tests__/backward-compatibility-0-0-57.test.ts` — unit tests.
- Modify: `sdks/typescript/packages/client/src/middleware/index.ts` — export the class.
- Modify: `sdks/typescript/packages/client/src/agent/agent.ts` — register behind the version gate.
- Modify: `sdks/typescript/packages/client/package.json` — bump `version` `0.0.57` → `0.0.58`.

---

## Task 1: Implement `BackwardCompatibility_0_0_57` with unit tests

**Files:**
- Create: `sdks/typescript/packages/client/src/middleware/backward-compatibility-0-0-57.ts`
- Test: `sdks/typescript/packages/client/src/middleware/__tests__/backward-compatibility-0-0-57.test.ts`

**Interfaces:**
- Consumes: `Middleware`/`runNext` (base class), `RunAgentInput`, `BaseEvent`, `EventType` from `@ag-ui/core`.
- Produces: `export class BackwardCompatibility_0_0_57 extends Middleware` whose `run()` (a) strips `subagentId` from every `input.messages[*]` before `runNext`, and (b) on the output stream drops `SUBAGENT_STARTED/FINISHED/ERROR` events and strips `subagentId` from every remaining event and from each message inside a `MESSAGES_SNAPSHOT`.

- [ ] **Step 1: Write the failing test**

Read the sibling test `sdks/typescript/packages/client/src/middleware/__tests__/backward-compatibility-0-0-45.test.ts` first to match its harness (how it constructs a stub `next` agent, feeds events, and asserts on the output). Then create the test file:

```typescript
import { describe, it, expect } from "vitest";
import { firstValueFrom, of, Subject } from "rxjs";
import { toArray } from "rxjs/operators";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { AbstractAgent } from "@/agent/agent";
import { BackwardCompatibility_0_0_57 } from "../backward-compatibility-0-0-57";

// Minimal stub agent: captures the input it receives and emits a scripted stream.
function makeNext(script: BaseEvent[], captured: { input?: RunAgentInput }): AbstractAgent {
  return {
    run(input: RunAgentInput) {
      captured.input = input;
      return of(...script);
    },
  } as unknown as AbstractAgent;
}

function baseInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

describe("BackwardCompatibility_0_0_57", () => {
  it("strips subagentId from input messages before the agent sees them", async () => {
    const captured: { input?: RunAgentInput } = {};
    const mw = new BackwardCompatibility_0_0_57();
    const input = baseInput({
      messages: [
        { id: "m1", role: "assistant", content: "hi", subagentId: "sub-1" } as any,
        { id: "m2", role: "user", content: "yo" } as any,
      ],
    });

    await firstValueFrom(mw.run(input, makeNext([], captured)).pipe(toArray()));

    expect((captured.input!.messages[0] as any).subagentId).toBeUndefined();
    expect(captured.input!.messages[0].content).toBe("hi"); // other fields preserved
    expect((captured.input!.messages[1] as any).subagentId).toBeUndefined();
  });

  it("drops SUBAGENT_STARTED/FINISHED/ERROR events from the output stream", async () => {
    const captured: { input?: RunAgentInput } = {};
    const mw = new BackwardCompatibility_0_0_57();
    const script: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as any,
      { type: EventType.SUBAGENT_STARTED, subagentId: "s1", name: "R" } as any,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", subagentId: "s1" } as any,
      { type: EventType.SUBAGENT_ERROR, subagentId: "s1", message: "x" } as any,
      { type: EventType.SUBAGENT_FINISHED, subagentId: "s1" } as any,
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as any,
    ];

    const out = await firstValueFrom(mw.run(baseInput(), makeNext(script, captured)).pipe(toArray()));

    const types = out.map((e) => e.type);
    expect(types).not.toContain(EventType.SUBAGENT_STARTED);
    expect(types).not.toContain(EventType.SUBAGENT_FINISHED);
    expect(types).not.toContain(EventType.SUBAGENT_ERROR);
    expect(types).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.RUN_FINISHED,
    ]);
  });

  it("strips subagentId from surviving events", async () => {
    const captured: { input?: RunAgentInput } = {};
    const mw = new BackwardCompatibility_0_0_57();
    const script: BaseEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", subagentId: "s1" } as any,
    ];
    const out = await firstValueFrom(mw.run(baseInput(), makeNext(script, captured)).pipe(toArray()));
    expect((out[0] as any).subagentId).toBeUndefined();
    expect((out[0] as any).messageId).toBe("m1");
  });

  it("strips subagentId from messages inside MESSAGES_SNAPSHOT", async () => {
    const captured: { input?: RunAgentInput } = {};
    const mw = new BackwardCompatibility_0_0_57();
    const script: BaseEvent[] = [
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "m1", role: "assistant", content: "hi", subagentId: "s1" },
          { id: "m2", role: "user", content: "yo" },
        ],
      } as any,
    ];
    const out = await firstValueFrom(mw.run(baseInput(), makeNext(script, captured)).pipe(toArray()));
    const snap = out[0] as any;
    expect(snap.messages[0].subagentId).toBeUndefined();
    expect(snap.messages[0].content).toBe("hi");
    expect(snap.messages[1].subagentId).toBeUndefined();
  });

  it("leaves a subagent-free stream and input untouched", async () => {
    const captured: { input?: RunAgentInput } = {};
    const mw = new BackwardCompatibility_0_0_57();
    const script: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as any,
      { type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" } as any,
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as any,
    ];
    const input = baseInput({ messages: [{ id: "m0", role: "user", content: "hi" } as any] });
    const out = await firstValueFrom(mw.run(input, makeNext(script, captured)).pipe(toArray()));
    expect(out.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.RUN_FINISHED,
    ]);
    expect(captured.input!.messages[0].content).toBe("hi");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `sdks/typescript`: `pnpm --filter @ag-ui/client test -- src/middleware/__tests__/backward-compatibility-0-0-57.test.ts`
Expected: FAIL — module `../backward-compatibility-0-0-57` does not exist.

- [ ] **Step 3: Implement the shim**

Create `backward-compatibility-0-0-57.ts`:

```typescript
import { Middleware } from "./middleware";
import { AbstractAgent } from "@/agent";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { Observable } from "rxjs";
import { filter, map } from "rxjs/operators";

// Subagent lifecycle event types (introduced after 0.0.57). Referenced as string
// literals so this shim keeps compiling if the enum members are ever removed.
const SUBAGENT_STARTED = "SUBAGENT_STARTED";
const SUBAGENT_FINISHED = "SUBAGENT_FINISHED";
const SUBAGENT_ERROR = "SUBAGENT_ERROR";

/** Returns a shallow copy of `obj` with any `subagentId` key removed. */
function stripSubagentId<T extends object>(obj: T): T {
  if (obj && typeof obj === "object" && "subagentId" in obj) {
    const { subagentId: _subagentId, ...rest } = obj as T & { subagentId?: unknown };
    return rest as T;
  }
  return obj;
}

/**
 * Middleware that removes all subagent-support additions when talking to a
 * pre-subagent (<= 0.0.57) agent:
 *  - input:  strips `subagentId` from every message before the agent sees it.
 *  - output: drops SUBAGENT_STARTED/FINISHED/ERROR events entirely, and strips
 *            `subagentId` from every remaining event and from each message inside
 *            a MESSAGES_SNAPSHOT.
 *
 * The subagent feature is purely additive, so this shim is a pure removal in both
 * directions; there is no field/event to translate (unlike 0.0.45's THINKING→REASONING).
 */
export class BackwardCompatibility_0_0_57 extends Middleware {
  override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    const sanitizedInput: RunAgentInput = {
      ...input,
      messages: (input.messages ?? []).map((message) => stripSubagentId(message)),
    } as RunAgentInput;

    return this.runNext(sanitizedInput, next).pipe(
      filter((event) => {
        const type = event.type as string;
        return (
          type !== SUBAGENT_STARTED && type !== SUBAGENT_FINISHED && type !== SUBAGENT_ERROR
        );
      }),
      map((event) => {
        const stripped = stripSubagentId(event);
        if (stripped.type === EventType.MESSAGES_SNAPSHOT) {
          const snapshot = stripped as BaseEvent & { messages?: Array<Record<string, unknown>> };
          if (Array.isArray(snapshot.messages)) {
            return {
              ...snapshot,
              messages: snapshot.messages.map((message) => stripSubagentId(message)),
            } as BaseEvent;
          }
        }
        return stripped;
      }),
    );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ag-ui/client test -- src/middleware/__tests__/backward-compatibility-0-0-57.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add sdks/typescript/packages/client/src/middleware/backward-compatibility-0-0-57.ts \
        sdks/typescript/packages/client/src/middleware/__tests__/backward-compatibility-0-0-57.test.ts
git commit -m "feat(client): add BackwardCompatibility_0_0_57 subagent-stripping shim"
```
End the commit body with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 2: Export the shim and register it behind the version gate (+ version bump)

**Files:**
- Modify: `sdks/typescript/packages/client/src/middleware/index.ts`
- Modify: `sdks/typescript/packages/client/src/agent/agent.ts`
- Modify: `sdks/typescript/packages/client/package.json`
- Test: `sdks/typescript/packages/client/src/middleware/__tests__/backward-compatibility-0-0-57.test.ts` (extend with a registration test)

**Interfaces:**
- Consumes: `BackwardCompatibility_0_0_57` (Task 1), `compareVersions`, the `maxVersion` getter.
- Produces: the shim auto-inserted into `this.middlewares` when `compareVersions(this.maxVersion, "0.0.57") <= 0`; a default client (bumped to `0.0.58`) does NOT insert it.

- [ ] **Step 1: Write the failing registration test**

Append to the Task 1 test file. This asserts the gate via a subclass that overrides `maxVersion` (mirroring how integration packages do it). Use whatever the sibling tests use to observe middleware insertion — if `middlewares` is private, assert observable behavior instead: a subagent event is dropped when the agent reports an old `maxVersion`, and passes through when it reports a new one. Prefer the behavioral assertion:

```typescript
import { HttpAgent } from "@/agent/http"; // or the minimal concrete AbstractAgent used by sibling tests

// Pseudocode contract — adapt to the concrete agent test util in this package:
// 1. Build an agent subclass whose `get maxVersion() { return "0.0.57"; }` and whose
//    underlying run() emits a SUBAGENT_STARTED. Assert the consumer-visible stream
//    (after middleware) does NOT contain SUBAGENT_STARTED.
// 2. Build one whose `get maxVersion() { return "0.0.58"; }` emitting the same, and
//    assert SUBAGENT_STARTED IS present (shim not applied).
```

If the sibling `backward-compatibility-0-0-45.test.ts` instead reaches into the middleware list or uses a documented test agent, follow that exact approach rather than inventing one.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ag-ui/client test -- src/middleware/__tests__/backward-compatibility-0-0-57.test.ts`
Expected: FAIL — shim not yet exported/registered, so `SUBAGENT_STARTED` is not stripped.

- [ ] **Step 3: Export from `middleware/index.ts`**

Add after the `0.0.47` export:

```typescript
export { BackwardCompatibility_0_0_57 } from "./backward-compatibility-0-0-57";
```

- [ ] **Step 4: Register in `agent.ts`**

Import the class in the middleware import group, then add after the `0.0.47` registration block in the constructor:

```typescript
// Auto-insert BackwardCompatibility_0_0_57 for backward compatibility with
// pre-subagent agents: strips subagentId + drops SUBAGENT_* lifecycle events.
if (compareVersions(this.maxVersion, "0.0.57") <= 0) {
  this.middlewares.unshift(new BackwardCompatibility_0_0_57());
}
```

- [ ] **Step 5: Bump the client version (required — see Global Constraints)**

In `sdks/typescript/packages/client/package.json`, change `"version": "0.0.57"` → `"version": "0.0.58"`. This makes the default `maxVersion` (`0.0.58`) fail the `<= "0.0.57"` gate so modern clients keep their subagent data. Confirm the exact version with the release owner.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @ag-ui/client test -- src/middleware/__tests__/backward-compatibility-0-0-57.test.ts`
Expected: PASS.

- [ ] **Step 7: Full client suite + typecheck**

Run from `sdks/typescript`:
```bash
pnpm --filter @ag-ui/client test
pnpm --filter @ag-ui/core --filter @ag-ui/client build
cd packages/client && npx tsc --noEmit -p tsconfig.json
```
Expected: tests pass (the pre-existing `esm-interop` test passes with `@ag-ui/proto` built); no new `agent.ts`/`middleware` type errors.

- [ ] **Step 8: Commit**

```bash
git add sdks/typescript/packages/client/src/middleware/index.ts \
        sdks/typescript/packages/client/src/agent/agent.ts \
        sdks/typescript/packages/client/package.json \
        sdks/typescript/packages/client/src/middleware/__tests__/backward-compatibility-0-0-57.test.ts
git commit -m "feat(client): register 0.0.57 subagent shim behind version gate and bump to 0.0.58"
```
End the commit body with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 3: End-to-end integration test through the run pipeline

**Files:**
- Test: `sdks/typescript/packages/client/src/middleware/__tests__/backward-compatibility-0-0-57.test.ts` (extend), or a new integration test alongside `middleware-chained-integration.test.ts` if that better matches repo conventions.

**Interfaces:**
- Consumes: the registered shim + the full `runAgent` pipeline (`middleware → transformChunks → verifyEvents → apply`).

- [ ] **Step 1: Write the failing/ý integration test**

Read `sdks/typescript/packages/client/src/middleware/__tests__/middleware-chained-integration.test.ts` to match the end-to-end harness. Then add a test that drives a full run of an agent whose `maxVersion` is `"0.0.57"` and whose raw stream includes `SUBAGENT_STARTED`, a `TEXT_MESSAGE_START` carrying `subagentId`, and `SUBAGENT_FINISHED`; assert that:
- the resulting `messages` carry no `subagentId`, and
- no `onSubagentStartedEvent`/`Finished`/`Error` subscriber hook fires (the lifecycle events were dropped before `apply`).

This proves the shim runs at the correct pipeline position (innermost, before `verifyEvents`/`apply`) so the downstream verifier never sees an unbalanced/attributed stream.

- [ ] **Step 2: Run it — confirm the assertions hold**

Run: `pnpm --filter @ag-ui/client test -- <path-to-integration-test>`
Expected: PASS. If it fails because lifecycle hooks still fire or `subagentId` survives, the shim is registered at the wrong pipeline position — reconcile with `agent.ts` `runAgent` ordering before proceeding.

- [ ] **Step 3: Commit**

```bash
git add <path-to-integration-test>
git commit -m "test(client): e2e verify 0.0.57 shim strips subagents through the run pipeline"
```
End the commit body with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Task 4: Verification + docs correction

- [ ] **Step 1: Full affected verification**

From `sdks/typescript`: `pnpm --filter @ag-ui/core --filter @ag-ui/client test` and `... build`; from `sdks/python`: `python -m unittest discover tests` (unchanged — sanity only, Python is not touched).

- [ ] **Step 2: Correct the design spec**

In `docs/superpowers/specs/2026-07-07-subagent-support-design.md`, fix the Phase 2 backwards-compatibility claim (which currently states consumers "already tolerate unknown event types"). Replace with the verified truth: the HTTP/SSE and proto decode paths validate against the closed `EventSchemas` discriminated union and error the stream on an unknown `type`; cross-version safety relies on version negotiation, and this shim provides the new-client↔old-agent downgrade. Reference `client/src/transform/http.ts:55-64`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-07-subagent-support-design.md
git commit -m "docs: correct subagent Phase 2 backward-compat rationale"
```
End the commit body with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Self-Review Notes

- **Coverage:** input message stripping (Task 1), output event drop + strip + MESSAGES_SNAPSHOT (Task 1), version-gated registration + bump (Task 2), pipeline-position e2e (Task 3), spec correction (Task 4).
- **Consistency:** class/file/threshold naming matches the `0.0.39/45/47` shims; `stripSubagentId` mirrors `sanitizeMessageContent`'s non-mutating spread style; registration mirrors the existing `compareVersions(... ) <= 0` blocks.
- **Key risk (flagged):** the `0.0.57` threshold is inert unless the client version is bumped to `0.0.58` in the same change (Task 2 Step 5) — the single most important step; without it, every default client strips its own subagent data.
- **Open decision:** exact target version for the bump (assumed `0.0.58`) — confirm with the release owner.
- **Out of scope (intentional):** Python SDK (no middleware layer); making genuinely-old consumers tolerate new events (inherent version-negotiation concern, not solvable by a client-side shim).
