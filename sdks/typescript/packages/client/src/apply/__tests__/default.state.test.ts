import { AbstractAgent } from "@/agent";
import { defaultApplyEvents } from "../default";
import { EventType, Message, StateDeltaEvent } from "@ag-ui/core";
import { lastValueFrom, of, toArray } from "rxjs";
import { DebugLogger } from "@/debug-logger";
import { AgentStateMutation } from "@/agent/subscriber";
import { describe, it, expect, vi } from "vitest";

const createAgent = (messages: Message[] = []) =>
  ({
    messages: messages.map((message) => ({ ...message })),
    state: {},
  }) as unknown as AbstractAgent;

describe("defaultApplyEvents - State Patching", () => {
  it("should apply state delta patch correctly", () => {
    return new Promise<void>((resolve) => {
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

      const agent = createAgent(initialState.messages as Message[]);
      const result$ = defaultApplyEvents(initialState, events$, agent, []);

      result$.subscribe((update: AgentStateMutation) => {
        expect(update.state).toEqual({
          count: 1,
          text: "world",
        });
        resolve();
      });
    });
  });

  it("should handle nested state updates", () => {
    return new Promise<void>((resolve) => {
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
      const agent = createAgent((initialState as any).messages as Message[]);
      const result$ = defaultApplyEvents(initialState as any, events$, agent, []);

      result$.subscribe((update: AgentStateMutation) => {
        expect(update.state).toEqual({
          user: {
            name: "John",
            settings: {
              theme: "dark",
            },
          },
        });
        resolve();
      });
    });
  });

  it("should handle array updates", () => {
    return new Promise<void>((resolve) => {
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
      const agent = createAgent((initialState as any).messages as Message[]);
      const result$ = defaultApplyEvents(initialState as any, events$, agent, []);

      result$.subscribe((update: AgentStateMutation) => {
        expect(update.state).toEqual({
          items: ["x", "b", "c", "d"],
        });
        resolve();
      });
    });
  });

  it("should handle multiple patches in sequence", () => {
    return new Promise<void>((resolve) => {
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
      const agent = createAgent((initialState as any).messages as Message[]);
      const result$ = defaultApplyEvents(initialState as any, events$, agent, []);

      let updateCount = 0;
      result$.subscribe((update: AgentStateMutation) => {
        updateCount++;
        if (updateCount === 2) {
          expect(update.state).toEqual({
            counter: 2,
          });
          resolve();
        }
      });
    });
  });

  it("should handle invalid patch operations gracefully", () => {
    return new Promise<void>((resolve) => {
      // Suppress console.warn for this test
      const originalWarn = console.warn;
      console.warn = vi.fn();

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
      const agent = createAgent((initialState as any).messages as Message[]);
      const result$ = defaultApplyEvents(initialState as any, events$, agent, []);

      let updateCount = 0;
      result$.subscribe({
        next: (_update: AgentStateMutation) => {
          updateCount++;
        },
        complete: () => {
          // When patch fails, no updates should be emitted
          expect(updateCount).toBe(0);
          // Restore original console.warn
          console.warn = originalWarn;
          resolve();
        },
      });
    });
  });
  describe("a patch that cannot apply", () => {
    const input = {
      messages: [],
      state: { profile: { email: "doc-secret" } },
      threadId: "test-thread",
      runId: "test-run",
      tools: [],
      context: [],
    };
    const failing: StateDeltaEvent = {
      type: EventType.STATE_DELTA,
      delta: [
        { op: "add", path: "/profile/name", value: "Ada" },
        { op: "replace", path: "/missing/key", value: "patch-secret" },
      ],
    };
    const run = (debugLogger?: DebugLogger) =>
      lastValueFrom(
        defaultApplyEvents(input, of(failing), createAgent(), [], debugLogger).pipe(toArray()),
      );
    const logged = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((call) => call.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")).join("\n");

    it("warns with the failing operation, not the state or the patch values", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await run();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(logged(warn)).toContain("Failed to apply state patch");
        expect(logged(warn)).toContain("operation 2 of 2: replace /missing/key");
        expect(logged(warn)).not.toMatch(/doc-secret|patch-secret/);
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      ["verbose", true, true],
      ["summary", false, false],
    ])("logs %s detail to the opt-in debug logger", async (_mode, verbose, detailed) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      try {
        await run(new DebugLogger({ enabled: true, events: true, lifecycle: false, verbose }));
        const debugged = logged(debug);
        expect(debugged).toContain("State patch failed");
        // Verbose mode is where the full state belongs; summary mode keeps a count.
        expect(debugged.includes("doc-secret")).toBe(detailed);
        if (!detailed) expect(debugged).toContain('"operations":2');
        expect(logged(warn)).not.toMatch(/doc-secret|patch-secret/);
      } finally {
        warn.mockRestore();
        debug.mockRestore();
      }
    });
  });
});
