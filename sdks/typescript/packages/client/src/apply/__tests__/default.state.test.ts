import { AbstractAgent } from "@/agent";
import { defaultApplyEvents } from "../default";
import { EventType, StateDeltaEvent } from "@ag-ui/core";
import { of } from "rxjs";
import { AgentStateMutation } from "@/agent/subscriber";

const FAKE_AGENT = null as unknown as AbstractAgent;

describe("defaultApplyEvents - State Patching", () => {
  it("should apply state delta patch correctly", (done) => {
    const initialState = {
      messages: [],
      state: {
        count: 0,
        text: "hello",
      },
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const stateDelta: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      delta: [
        { op: "replace", path: "/count", value: 1 },
        { op: "replace", path: "/text", value: "world" },
      ],
    };

    const events$ = of(stateDelta);

    const result$ = defaultApplyEvents(initialState, events$, FAKE_AGENT, []);

    result$.subscribe((update: AgentStateMutation) => {
      expect(update.state).toEqual({
        count: 1,
        text: "world",
      });
      done();
    });
  });

  it("should handle nested state updates", (done) => {
    const initialState = {
      messages: [],
      state: {
        user: {
          name: "John",
          settings: {
            theme: "light",
          },
        },
      },
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const stateDelta: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      delta: [{ op: "replace", path: "/user/settings/theme", value: "dark" }],
    };

    const events$ = of(stateDelta);
    // Cast to any to bypass strict type checking
    const result$ = defaultApplyEvents(initialState as any, events$, FAKE_AGENT, []);

    result$.subscribe((update: AgentStateMutation) => {
      expect(update.state).toEqual({
        user: {
          name: "John",
          settings: {
            theme: "dark",
          },
        },
      });
      done();
    });
  });

  it("should handle array updates", (done) => {
    const initialState = {
      messages: [],
      state: {
        items: ["a", "b", "c"],
      },
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const stateDelta: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      delta: [
        { op: "add", path: "/items/-", value: "d" },
        { op: "replace", path: "/items/0", value: "x" },
      ],
    };

    const events$ = of(stateDelta);
    // Cast to any to bypass strict type checking
    const result$ = defaultApplyEvents(initialState as any, events$, FAKE_AGENT, []);

    result$.subscribe((update: AgentStateMutation) => {
      expect(update.state).toEqual({
        items: ["x", "b", "c", "d"],
      });
      done();
    });
  });

  it("should handle multiple patches in sequence", (done) => {
    const initialState = {
      messages: [],
      state: {
        counter: 0,
      },
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    const stateDeltas: StateDeltaEvent[] = [
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/counter", value: 1 }],
      },
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "replace", path: "/counter", value: 2 }],
      },
    ];

    const events$ = of(...stateDeltas);
    // Cast to any to bypass strict type checking
    const result$ = defaultApplyEvents(initialState as any, events$, FAKE_AGENT, []);

    let updateCount = 0;
    result$.subscribe((update: AgentStateMutation) => {
      updateCount++;
      if (updateCount === 2) {
        expect(update.state).toEqual({
          counter: 2,
        });
        done();
      }
    });
  });

  it("should handle invalid patch operations gracefully", (done) => {
    // Suppress console.warn for this test
    const originalWarn = console.warn;
    console.warn = jest.fn();

    const initialState = {
      messages: [],
      state: {
        count: 0,
        text: "hello",
      },
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };

    // Invalid patch: trying to replace a non-existent path
    const stateDelta: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      delta: [{ op: "replace", path: "/nonexistent", value: 1 }],
    };

    const events$ = of(stateDelta);
    // Cast to any to bypass strict type checking
    const result$ = defaultApplyEvents(initialState as any, events$, FAKE_AGENT, []);

    let updateCount = 0;
    result$.subscribe({
      next: (update: AgentStateMutation) => {
        updateCount++;
      },
      complete: () => {
        // When patch fails, no updates should be emitted
        expect(updateCount).toBe(0);
        // Restore original console.warn
        console.warn = originalWarn;
        done();
      },
    });
  });
});
