/**
 * Tests for `InMemoryRunStateStore` — the default `RunStateStore` impl used to
 * persist the shared `currentState` across a HITL pause/resume. (Phase 5.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { InMemoryRunStateStore } from "./state";

describe("InMemoryRunStateStore — basic round-trip", () => {
  it("get returns undefined for an unknown threadId", async () => {
    const store = new InMemoryRunStateStore();
    expect(await store.get("t1")).toBeUndefined();
  });

  it("set / get round-trips the stashed state", async () => {
    const store = new InMemoryRunStateStore();
    await store.set("t1", { count: 1 });
    expect(await store.get("t1")).toEqual({ count: 1 });
  });

  it("set replaces an existing entry", async () => {
    const store = new InMemoryRunStateStore();
    await store.set("t1", { count: 1 });
    await store.set("t1", { count: 2 });
    expect(await store.get("t1")).toEqual({ count: 2 });
  });

  it("delete removes an entry", async () => {
    const store = new InMemoryRunStateStore();
    await store.set("t1", { count: 1 });
    await store.delete("t1");
    expect(await store.get("t1")).toBeUndefined();
  });

  it("delete is a no-op for an unknown threadId", async () => {
    const store = new InMemoryRunStateStore();
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });
});

describe("InMemoryRunStateStore — TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts an idle entry once it is older than ttlMs", async () => {
    const store = new InMemoryRunStateStore({ ttlMs: 1000 });
    await store.set("t1", { count: 1 });
    expect(await store.get("t1")).toEqual({ count: 1 });

    // Advance past the TTL.
    vi.advanceTimersByTime(1001);
    expect(await store.get("t1")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("keeps an entry that is touched within the TTL", async () => {
    const store = new InMemoryRunStateStore({ ttlMs: 1000 });
    await store.set("t1", { count: 1 });

    vi.advanceTimersByTime(600);
    expect(await store.get("t1")).toEqual({ count: 1 }); // touches lastUsed

    vi.advanceTimersByTime(600); // 1200ms total since set, but only 600 since last get
    expect(await store.get("t1")).toEqual({ count: 1 });
  });
});

describe("InMemoryRunStateStore — LRU cap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts the oldest idle entries when over maxStates", async () => {
    const store = new InMemoryRunStateStore({ maxStates: 2, ttlMs: 100000 });
    await store.set("t1", { n: 1 }); // t=0
    vi.advanceTimersByTime(10);
    await store.set("t2", { n: 2 }); // t=10
    vi.advanceTimersByTime(10);
    await store.set("t3", { n: 3 }); // t=20 → over cap (3 > 2), evict oldest (t1)

    expect(store.size).toBe(2);
    expect(await store.get("t1")).toBeUndefined();
    expect(await store.get("t2")).toEqual({ n: 2 });
    expect(await store.get("t3")).toEqual({ n: 3 });
  });

  it("promotes an entry on get so it is not the oldest", async () => {
    const store = new InMemoryRunStateStore({ maxStates: 2, ttlMs: 100000 });
    await store.set("t1", { n: 1 }); // t=0
    vi.advanceTimersByTime(10);
    await store.set("t2", { n: 2 }); // t=10
    vi.advanceTimersByTime(10);
    // Touch t1 so it becomes the most-recently-used; t2 is now oldest.
    expect(await store.get("t1")).toEqual({ n: 1 });
    vi.advanceTimersByTime(10);
    await store.set("t3", { n: 3 }); // over cap → evict oldest (t2)

    expect(await store.get("t1")).toEqual({ n: 1 });
    expect(await store.get("t2")).toBeUndefined();
    expect(await store.get("t3")).toEqual({ n: 3 });
  });
});
