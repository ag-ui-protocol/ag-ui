/**
 * Tests for session manager provider lifecycle in StrandsAgent.
 *
 * Port of Python's test_session_manager.py — covers caching, async providers,
 * null returns, and retry semantics.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "@strands-agents/sdk";
import { EventType } from "@ag-ui/core";

import { StrandsAgent } from "../agent";
import { collect, minimalRunInput, scriptedAgent } from "./helpers";

// Mock the Strands Agent constructor so tests don't need a real model provider.
vi.mock("@strands-agents/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@strands-agents/sdk")>();
  class MockAgent {
    model = { name: "mock" };
    tools: unknown[] = [];
    toolRegistry = {
      _tools: new Map<string, unknown>(),
      add(t: unknown) {
        this._tools.set((t as { name: string }).name, t);
      },
      getByName(name: string) {
        return this._tools.get(name);
      },
      get(name: string) {
        return this._tools.get(name);
      },
      removeByName(name: string) {
        this._tools.delete(name);
      },
      remove(name: unknown) {
        if (typeof name === "string") this._tools.delete(name);
      },
      values() {
        return Array.from(this._tools.values());
      },
    };
    async *stream() {
      /* empty */
    }
  }
  return {
    ...actual,
    Agent: MockAgent,
  };
});

/**
 * A minimal SessionManager subclass that records calls but doesn't hit any
 * real storage. Subclassing ensures `instanceof SessionManager` passes.
 */
class FakeSessionManager extends SessionManager {
  static instances: FakeSessionManager[] = [];
  constructor() {
    super({
      sessionId: `fake-${Math.random().toString(36).slice(2)}`,
      storage: {
        snapshot: { save: vi.fn(), load: vi.fn(), delete: vi.fn() } as never,
      },
    });
    FakeSessionManager.instances.push(this);
  }
}
function fakeSessionManager(): FakeSessionManager {
  return new FakeSessionManager();
}

describe("Session manager provider — caching", () => {
  it("provider is called only once per thread", async () => {
    const provider = vi.fn().mockReturnValue(fakeSessionManager());
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: provider },
    });

    await collect(agent, minimalRunInput({ threadId: "thread-A" }));
    await collect(agent, minimalRunInput({ threadId: "thread-A" }));

    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("different threads get separate provider invocations", async () => {
    const provider = vi.fn().mockReturnValue(fakeSessionManager());
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: provider },
    });

    await collect(agent, minimalRunInput({ threadId: "thread-1" }));
    await collect(agent, minimalRunInput({ threadId: "thread-2" }));

    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("failed provider does not cache — allows retry", async () => {
    let callCount = 0;
    const provider = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error("transient failure");
      return fakeSessionManager();
    });
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: provider },
    });

    // First call fails
    const events1 = await collect(
      agent,
      minimalRunInput({ threadId: "retry-thread" }),
    );
    expect(
      events1.some(
        (e) =>
          (e as unknown as { code?: string }).code === "SESSION_MANAGER_ERROR",
      ),
    ).toBe(true);

    // Second call succeeds (provider retried)
    const events2 = await collect(
      agent,
      minimalRunInput({ threadId: "retry-thread" }),
    );
    expect(events2.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(provider).toHaveBeenCalledTimes(2);
  });
});

describe("Session manager provider — async", () => {
  it("awaits an async provider", async () => {
    const provider = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return fakeSessionManager();
    });
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: provider },
    });

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "async-thread" }),
    );
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe("Session manager provider — null/undefined return", () => {
  it("null return logs warning but does not error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = vi.fn().mockReturnValue(null);
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: provider },
    });

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "null-thread" }),
    );
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("returned null/undefined"),
    );
    warnSpy.mockRestore();
  });

  it("undefined return logs warning but does not error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = vi.fn().mockReturnValue(undefined);
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: provider },
    });

    const events = await collect(
      agent,
      minimalRunInput({ threadId: "undef-thread" }),
    );
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("Session manager provider — empty/falsy threadId", () => {
  it("uses 'default' key when threadId is empty string", async () => {
    const provider = vi.fn().mockReturnValue(fakeSessionManager());
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: provider },
    });

    await collect(agent, minimalRunInput({ threadId: "" }));
    await collect(agent, minimalRunInput({ threadId: "" }));

    // Both should resolve to "default" thread, so only one provider call
    expect(provider).toHaveBeenCalledTimes(1);
  });
});

describe("Session manager provider — strict instanceof validation", () => {
  it("rejects plain string with SESSION_MANAGER_INVALID_TYPE", async () => {
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => "not a sm" as unknown as never },
    });
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "invalid-string" }),
    );
    const err = events.find((e) => e.type === EventType.RUN_ERROR);
    expect(err).toBeDefined();
    expect((err as unknown as { code: string }).code).toBe(
      "SESSION_MANAGER_INVALID_TYPE",
    );
  });

  it("rejects plain object with register() (HookProvider-shaped)", async () => {
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: {
        sessionManagerProvider: () =>
          ({ register: () => void 0 }) as unknown as never,
      },
    });
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "invalid-hook-provider" }),
    );
    const err = events.find((e) => e.type === EventType.RUN_ERROR);
    expect(err).toBeDefined();
    expect((err as unknown as { code: string }).code).toBe(
      "SESSION_MANAGER_INVALID_TYPE",
    );
  });

  it("accepts a SessionManager subclass instance", async () => {
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => fakeSessionManager() },
    });
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "valid-subclass" }),
    );
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("instanceof survives constructor name mangling (minifier-safe)", async () => {
    const sm = fakeSessionManager();
    // Simulate a minifier renaming the subclass constructor name.
    Object.defineProperty(sm.constructor, "name", { value: "M_a" });
    expect(sm.constructor.name).toBe("M_a");
    // Adapter should STILL accept this instance — instanceof walks the
    // prototype chain by identity, not by name.
    const agent = new StrandsAgent({
      agent: scriptedAgent(),
      name: "t",
      config: { sessionManagerProvider: () => sm },
    });
    const events = await collect(
      agent,
      minimalRunInput({ threadId: "minified-name" }),
    );
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);
  });
});
