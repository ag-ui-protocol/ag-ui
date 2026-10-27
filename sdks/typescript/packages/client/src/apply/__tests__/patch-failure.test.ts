import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { lastValueFrom, of, toArray } from "rxjs";
import jsonpatch from "fast-json-patch";
import {
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  type BaseEvent,
  EventType,
  type StateDeltaEvent,
  type StateSnapshotEvent,
} from "@ag-ui/core";
import { AbstractAgent } from "@/agent";
import { DebugLogger } from "@/debug-logger";
import { compactEvents } from "@/compact/compact";
import { convertToLegacyEvents } from "@/legacy/convert";
import { defaultApplyEvents } from "../default";
import { describePatchFailure } from "../patch-failure";

const SECRET = "secret@example.com";
const PATCH_VALUE = "also-secret";
const state = { profile: { email: SECRET } };
// Second operation fails: its parent path does not exist.
const failingPatch: StateDeltaEvent["delta"] = [
  { op: "add", path: "/profile/name", value: "Ada" },
  { op: "replace", path: "/missing/key", value: PATCH_VALUE },
];

function patchError(): unknown {
  try {
    jsonpatch.applyPatch(structuredClone(state), failingPatch, true, false);
  } catch (error) {
    return error;
  }
  throw new Error("expected the patch to fail");
}

function expectNoLeak(text: string) {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(PATCH_VALUE);
  expect(text).not.toContain("tree");
}

describe("describePatchFailure", () => {
  it("drops the document and values that fast-json-patch puts in its message", () => {
    const error = patchError() as Error;
    // The library's own message carries both; the description must not.
    expect(error.message).toContain(SECRET);

    const description = describePatchFailure(failingPatch, error);

    expectNoLeak(description);
    expect(description).toBe(
      "Cannot perform the operation at a path that does not exist (operation 2 of 2: replace /missing/key)",
    );
  });

  it("names the operation that failed, not the first one", () => {
    // fast-json-patch reports `index: 0` here; the operation it carries is right.
    const patch: StateDeltaEvent["delta"] = [
      { op: "add", path: "/a", value: 1 },
      { op: "add", path: "/b", value: 2 },
      { op: "remove", path: "/nope" },
    ];
    let error: unknown;
    try {
      jsonpatch.applyPatch({}, patch, true, false);
    } catch (caught) {
      error = caught;
    }
    expect((error as { index: number }).index).toBe(0);
    expect(describePatchFailure(patch, error)).toContain("operation 3 of 3: remove /nope");
  });

  it("falls back to the operation count when the error names no operation", () => {
    expect(describePatchFailure(failingPatch, new Error("boom\nwith detail"))).toBe(
      "boom (2 operations)",
    );
    expect(describePatchFailure([], "not an error")).toBe("not an error (0 operations)");
  });
});

describe("patch failure warnings", () => {
  let warn: MockInstance<typeof console.warn>;
  let priorSuppress: string | undefined;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // compact and legacy warnings honour this flag; assert with it off.
    priorSuppress = process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
    delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
  });
  afterEach(() => {
    warn.mockRestore();
    if (priorSuppress === undefined) delete process.env.SUPPRESS_TRANSFORMATION_WARNINGS;
    else process.env.SUPPRESS_TRANSFORMATION_WARNINGS = priorSuppress;
  });
  const warned = () => warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
  const agent = () => ({ messages: [], state: {} }) as unknown as AbstractAgent;
  const input = (overrides: Record<string, unknown> = {}) =>
    ({
      messages: [],
      state,
      threadId: "t",
      runId: "r",
      tools: [],
      context: [],
      ...overrides,
    }) as any;

  it("state delta", async () => {
    const delta: StateDeltaEvent = { type: EventType.STATE_DELTA, delta: failingPatch };
    await lastValueFrom(defaultApplyEvents(input(), of(delta), agent(), []).pipe(toArray()));

    expect(warned()).toContain("Failed to apply state patch");
    expect(warned()).toContain("operation 2 of 2: replace /missing/key");
    expectNoLeak(warned());
  });

  it("activity delta", async () => {
    const events: BaseEvent[] = [
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "act-1",
        activityType: "form",
        content: state,
      } as ActivitySnapshotEvent,
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: "act-1",
        activityType: "form",
        patch: failingPatch,
      } as ActivityDeltaEvent,
    ];
    await lastValueFrom(
      defaultApplyEvents(input({ state: {} }), of(...events), agent(), []).pipe(toArray()),
    );

    expect(warned()).toContain("Failed to apply activity patch for 'act-1'");
    expectNoLeak(warned());
  });

  it("compaction", () => {
    compactEvents([
      { type: EventType.STATE_SNAPSHOT, snapshot: state } as StateSnapshotEvent,
      { type: EventType.STATE_DELTA, delta: failingPatch } as StateDeltaEvent,
    ]);

    expect(warned()).toContain("Failed to apply state patch while compacting");
    expectNoLeak(warned());
  });

  it("legacy conversion", async () => {
    await lastValueFrom(
      convertToLegacyEvents(
        "t",
        "r",
        "agent",
      )(
        of(
          { type: EventType.STATE_SNAPSHOT, snapshot: state } as StateSnapshotEvent,
          { type: EventType.STATE_DELTA, delta: failingPatch } as StateDeltaEvent,
        ),
      ).pipe(toArray()),
    );

    expect(warned()).toContain("[ag-ui][legacy] Failed to apply state patch");
    expectNoLeak(warned());
  });

  it("keeps the full detail for the opt-in debug logger", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const delta: StateDeltaEvent = { type: EventType.STATE_DELTA, delta: failingPatch };
      const logger = new DebugLogger({
        enabled: true,
        events: true,
        lifecycle: false,
        verbose: true,
      });
      await lastValueFrom(
        defaultApplyEvents(input(), of(delta), agent(), [], logger).pipe(toArray()),
      );

      const logged = debug.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      expect(logged).toContain("State patch failed");
      expect(logged).toContain(SECRET);
      expectNoLeak(warned());
    } finally {
      debug.mockRestore();
    }
  });
});
