/**
 * Tests for interrupt detection across parallel tasks — fixes #1409.
 *
 * The bug: interrupt checking only looked at tasks[0], so if a parallel
 * tool call had the interrupt on tasks[1] or later, it was silently missed.
 *
 * NOTE: LangGraphAgent can't be instantiated in tests (requires @ag-ui/client
 * which needs protoc). We test the interrupt collection pattern directly.
 * This MUST stay in sync with agent.ts lines ~404 and ~626:
 *   (tasks ?? []).flatMap((t: any) => t.interrupts ?? [])
 * If the agent reverts to tasks?.[0]?.interrupts, these tests won't catch it.
 * A future improvement would be to extract a collectInterrupts helper.
 */

import { describe, it, expect } from "vitest";

interface FakeInterrupt {
  value: unknown;
}

interface FakeTask {
  interrupts: FakeInterrupt[];
}

/**
 * Mirrors the interrupt collection logic from agent.ts.
 * Must stay in sync with the actual implementation.
 */
function collectInterrupts(tasks: FakeTask[] | undefined | null): FakeInterrupt[] {
  return (tasks ?? []).flatMap((t) => t.interrupts ?? []);
}

describe("Interrupt Detection (issue #1409)", () => {
  it("should detect interrupt on single task", () => {
    const tasks = [{ interrupts: [{ value: "please confirm" }] }];
    const interrupts = collectInterrupts(tasks);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].value).toBe("please confirm");
  });

  it("should return empty for single task without interrupt", () => {
    const tasks = [{ interrupts: [] }];
    expect(collectInterrupts(tasks)).toHaveLength(0);
  });

  it("should detect interrupt on tasks[1] (the #1409 bug)", () => {
    const tasks = [
      { interrupts: [] },
      { interrupts: [{ value: "confirm action B" }] },
    ];
    const interrupts = collectInterrupts(tasks);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].value).toBe("confirm action B");
  });

  it("should detect interrupt on tasks[2]", () => {
    const tasks = [
      { interrupts: [] },
      { interrupts: [] },
      { interrupts: [{ value: "confirm C" }] },
    ];
    expect(collectInterrupts(tasks)).toHaveLength(1);
  });

  it("should collect interrupts from multiple tasks", () => {
    const tasks = [
      { interrupts: [{ value: "A" }] },
      { interrupts: [{ value: "B" }] },
    ];
    const interrupts = collectInterrupts(tasks);
    expect(interrupts).toHaveLength(2);
    expect(interrupts.map((i) => i.value)).toContain("A");
    expect(interrupts.map((i) => i.value)).toContain("B");
  });

  it("should handle empty tasks list", () => {
    expect(collectInterrupts([])).toHaveLength(0);
  });

  it("should handle undefined tasks", () => {
    expect(collectInterrupts(undefined)).toHaveLength(0);
  });

  it("should handle null tasks", () => {
    expect(collectInterrupts(null)).toHaveLength(0);
  });

  it("should handle all tasks without interrupts", () => {
    const tasks = [{ interrupts: [] }, { interrupts: [] }];
    expect(collectInterrupts(tasks)).toHaveLength(0);
  });

  it("should handle task with interrupts key missing entirely", () => {
    // A task object with no interrupts key — the ?? [] guard makes it safe
    const tasks = [{} as FakeTask, { interrupts: [{ value: "found" }] }];
    const interrupts = collectInterrupts(tasks);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].value).toBe("found");
  });

  it("should handle task with interrupts as null", () => {
    const tasks = [{ interrupts: null as any }, { interrupts: [{ value: "ok" }] }];
    const interrupts = collectInterrupts(tasks);
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0].value).toBe("ok");
  });

  it("should collect from mixed batch of valid and missing-interrupt tasks", () => {
    const tasks = [
      {},
      { interrupts: [{ value: "A" }] },
      {},
      { interrupts: [{ value: "B" }] },
    ] as FakeTask[];
    const interrupts = collectInterrupts(tasks);
    expect(interrupts).toHaveLength(2);
    expect(interrupts.map((i) => i.value)).toContain("A");
    expect(interrupts.map((i) => i.value)).toContain("B");
  });
});
