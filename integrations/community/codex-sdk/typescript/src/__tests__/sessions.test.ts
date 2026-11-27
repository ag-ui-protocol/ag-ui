import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCodexSessionStore } from "../sessions";

afterEach(() => vi.useRealTimers());
describe("session store", () => {
  it("admits separate threads and rejects duplicate writers", () => {
    const store = new MemoryCodexSessionStore();
    store.acquire("one");
    store.acquire("two");
    expect(() => store.acquire("one")).toThrow("already active");
    store.release("one");
    expect(() => store.acquire("one")).not.toThrow();
  });
  it("never evicts an active session at capacity", () => {
    const store = new MemoryCodexSessionStore({ maxEntries: 1 });
    store.acquire("one");
    store.set("one", { status: "ready", nativeId: "n", fingerprints: [] });
    expect(() => store.acquire("two")).toThrow("All session slots");
    store.release("one");
    store.acquire("two");
    expect(store.get("one")).toBeUndefined();
  });
  it("expires only idle sessions and restarts the idle clock on release", () => {
    vi.useFakeTimers();
    const store = new MemoryCodexSessionStore({ idleTtlMs: 50 });
    store.acquire("one");
    store.set("one", { status: "ready", nativeId: "n", fingerprints: [] });
    vi.advanceTimersByTime(100);
    expect(store.get("one")?.nativeId).toBe("n");
    store.release("one");
    vi.advanceTimersByTime(49);
    expect(store.get("one")?.nativeId).toBe("n");
    vi.advanceTimersByTime(1);
    expect(store.get("one")).toBeUndefined();
  });
  it("does not expose mutable stored fingerprints", () => {
    const store = new MemoryCodexSessionStore();
    const fingerprints = ["hash"];
    store.acquire("one");
    store.set("one", { status: "ready", nativeId: "n", fingerprints });
    fingerprints.push("changed");
    store.get("one")?.fingerprints.push("also changed");
    expect(store.get("one")?.fingerprints).toEqual(["hash"]);
  });
  it("rejects invalid finite limits", () => {
    for (const value of [0, -1, Infinity, 1.5, NaN]) {
      expect(() => new MemoryCodexSessionStore({ maxEntries: value })).toThrow(
        "positive safe integer",
      );
      expect(() => new MemoryCodexSessionStore({ idleTtlMs: value })).toThrow(
        "positive safe integer",
      );
    }
  });
});
