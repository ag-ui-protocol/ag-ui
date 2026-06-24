/**
 * Plugins passed to `StrandsAgent` via the constructor must be forwarded
 * into `AgentConfig.plugins` on every per-thread Strands agent.
 *
 * Mirrors the Python adapter's hook-forwarding behavior.
 */

import { describe, it, expect, vi } from "vitest";
import type { Plugin } from "@strands-agents/sdk";
import { StrandsAgent } from "../agent";
import { collect, minimalRunInput } from "./helpers";

// Capture the AgentConfig passed to every per-thread Strands Agent
// constructor so we can assert plugins were forwarded.
const capturedConfigs: Array<Record<string, unknown>> = [];

vi.mock("@strands-agents/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@strands-agents/sdk")>();
  class MockAgent {
    model: unknown;
    tools: unknown[] = [];
    systemPrompt?: unknown;
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
    constructor(cfg?: Record<string, unknown>) {
      if (cfg) {
        capturedConfigs.push(cfg);
        this.model = cfg.model;
        this.tools = (cfg.tools as unknown[]) ?? [];
        this.systemPrompt = cfg.systemPrompt;
      }
    }
    // eslint-disable-next-line require-yield
    async *stream() {
      /* empty */
    }
  }
  return { ...actual, Agent: MockAgent };
});

function templateAgent(): import("@strands-agents/sdk").Agent {
  return {
    model: { name: "template-model" },
    tools: [],
    systemPrompt: "template",
    toolRegistry: {
      _tools: new Map<string, unknown>(),
      add: () => void 0,
      getByName: () => undefined,
      get: () => undefined,
      removeByName: () => void 0,
      remove: () => void 0,
      values: () => [],
    },
  } as unknown as import("@strands-agents/sdk").Agent;
}

describe("Plugin forwarding", () => {
  it("forwards the plugins array to every per-thread Strands agent", async () => {
    capturedConfigs.length = 0;
    const plugin1: Plugin = {
      name: "plugin-1",
      initAgent: vi.fn(),
    };
    const plugin2: Plugin = {
      name: "plugin-2",
      initAgent: vi.fn(),
    };
    const sa = new StrandsAgent({
      agent: templateAgent(),
      name: "t",
      plugins: [plugin1, plugin2],
    });

    await collect(sa, minimalRunInput({ threadId: "thread-A" }));
    await collect(sa, minimalRunInput({ threadId: "thread-B" }));
    await collect(sa, minimalRunInput({ threadId: "thread-C" }));

    // One per-thread agent per distinct thread — three AgentConfigs captured.
    expect(capturedConfigs).toHaveLength(3);
    for (const cfg of capturedConfigs) {
      const plugins = cfg.plugins as Plugin[] | undefined;
      expect(plugins).toBeDefined();
      expect(plugins).toHaveLength(2);
      expect(plugins?.[0]).toBe(plugin1);
      expect(plugins?.[1]).toBe(plugin2);
    }
  });

  it("omits the plugins key entirely when no plugins were supplied", async () => {
    capturedConfigs.length = 0;
    const sa = new StrandsAgent({ agent: templateAgent(), name: "t" });
    await collect(sa, minimalRunInput({ threadId: "no-plugins" }));
    expect(capturedConfigs).toHaveLength(1);
    expect("plugins" in capturedConfigs[0]!).toBe(false);
  });

  it("omits the plugins key when an empty array is supplied", async () => {
    capturedConfigs.length = 0;
    const sa = new StrandsAgent({
      agent: templateAgent(),
      name: "t",
      plugins: [],
    });
    await collect(sa, minimalRunInput({ threadId: "empty-plugins" }));
    expect(capturedConfigs).toHaveLength(1);
    expect("plugins" in capturedConfigs[0]!).toBe(false);
  });

  it("defensive copy: mutating the caller's array does not leak", async () => {
    capturedConfigs.length = 0;
    const callerArr: Plugin[] = [{ name: "p1", initAgent: vi.fn() }];
    const sa = new StrandsAgent({
      agent: templateAgent(),
      name: "t",
      plugins: callerArr,
    });
    // Mutate AFTER construction but BEFORE any run
    callerArr.push({ name: "p-injected", initAgent: vi.fn() });
    await collect(sa, minimalRunInput({ threadId: "defensive" }));
    const cfg = capturedConfigs[0]!;
    expect((cfg.plugins as Plugin[]).map((p) => p.name)).toEqual(["p1"]);
  });
});
