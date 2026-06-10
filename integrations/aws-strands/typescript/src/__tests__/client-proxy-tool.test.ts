import { describe, it, expect } from "vitest";
import type { Tool as AguiTool } from "@ag-ui/core";

import {
  createProxyTool,
  syncProxyTools,
  isProxyTool,
} from "../client-proxy-tool";
import { fakeTool } from "./helpers";

/**
 * Minimal fake that satisfies the Strands `ToolRegistry` contract used by
 * `syncProxyTools`: `add`, `get`, `remove`, `list`.
 */
function fakeRegistry() {
  const tools = new Map<
    string,
    { name: string; description: string; toolSpec: unknown }
  >();
  return {
    add(
      t:
        | { name: string; description: string; toolSpec: unknown }
        | Array<{ name: string; description: string; toolSpec: unknown }>,
    ) {
      for (const x of Array.isArray(t) ? t : [t]) tools.set(x.name, x);
    },
    get(name: string) {
      return tools.get(name);
    },
    remove(name: string) {
      tools.delete(name);
    },
    list() {
      return Array.from(tools.values());
    },
  };
}

function aguiTool(name: string, overrides: Partial<AguiTool> = {}): AguiTool {
  return {
    name,
    description: overrides.description ?? `Tool ${name}`,
    parameters: overrides.parameters ?? { type: "object", properties: {} },
    ...overrides,
  };
}

describe("createProxyTool", () => {
  it("produces a Tool carrying the AG-UI tool's name and description", () => {
    const tool = createProxyTool(
      aguiTool("my_tool", { description: "Does a thing" }),
    );
    expect(tool.name).toBe("my_tool");
    expect(tool.description).toBe("Does a thing");
    expect(tool.toolSpec.name).toBe("my_tool");
    expect(tool.toolSpec.inputSchema).toBeTypeOf("object");
  });

  it("marks proxy tools so they're distinguishable from native tools", () => {
    const tool = createProxyTool(aguiTool("x"));
    expect(isProxyTool(tool)).toBe(true);
  });

  it("synthesises a description when the AG-UI tool omits one", () => {
    // CopilotKit's useFrontendTool doesn't require a description; Strands'
    // tool registry rejects empty descriptions, so the proxy must fill in.
    const tool = createProxyTool({
      name: "generate_haiku",
      description: "",
      parameters: { type: "object", properties: {} },
    });
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.toolSpec.description.length).toBeGreaterThan(0);
    expect(tool.description).toContain("generate_haiku");
  });
});

describe("syncProxyTools", () => {
  it("registers new proxies for each AG-UI tool", () => {
    const reg = fakeRegistry();
    const names = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("a"), aguiTool("b")],
      new Set(),
    );
    expect(names).toEqual(new Set(["a", "b"]));
    expect(
      reg
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("evicts proxies that were tracked previously but are absent now", () => {
    const reg = fakeRegistry();
    const first = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("a"), aguiTool("b")],
      new Set(),
    );
    expect(first).toEqual(new Set(["a", "b"]));

    const second = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("a")],
      first,
    );
    expect(second).toEqual(new Set(["a"]));
    expect(reg.get("a")).toBeDefined();
    expect(reg.get("b")).toBeUndefined();
  });

  it("never overwrites a native (non-proxy) tool with the same name", () => {
    const reg = fakeRegistry();
    reg.add(fakeTool("native"));
    const names = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("native"), aguiTool("new_proxy")],
      new Set(),
    );
    // native survives, new_proxy registers
    expect(reg.get("native")).toBeDefined();
    // The native tool does not carry the proxy marker → still native.
    expect(isProxyTool(reg.get("native"))).toBe(false);
    // new_proxy is registered as proxy
    expect(names.has("new_proxy")).toBe(true);
    expect(names.has("native")).toBe(false);
  });

  it("warns explicitly when a native tool shadows a client-declared tool", () => {
    // Silent skipping leaves integrators wondering why their client tool
    // never fires. The collision must surface at log.warn so it shows up in
    // routine operator monitoring.
    const reg = fakeRegistry();
    reg.add(fakeTool("search"));
    const warnings: string[] = [];
    const mockLogger = {
      debug() {},
      warn(...args: unknown[]) {
        warnings.push(args.map(String).join(" "));
      },
      error() {},
    };
    syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("search")],
      new Set(),
      mockLogger,
    );
    expect(warnings.some((w) => w.includes('Native tool "search" shadows'))).toBe(
      true,
    );
  });

  it("passes an empty aguiTools array to evict every tracked proxy", () => {
    const reg = fakeRegistry();
    const first = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("a"), aguiTool("b")],
      new Set(),
    );
    const second = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [],
      first,
    );
    expect(second.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });

  it("is idempotent when the same tool list is passed twice", () => {
    const reg = fakeRegistry();
    const first = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("a", { description: "v1" })],
      new Set(),
    );
    const second = syncProxyTools(
      reg as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("a", { description: "v2" })],
      first,
    );
    expect(second).toEqual(new Set(["a"]));
    // Picks up the new description
    expect(reg.get("a")?.description).toBe("v2");
  });

  // The Strands v1 `ToolRegistry` throws if the same name is registered
  // twice, so `syncProxyTools` must explicitly remove before re-registering.
  it("re-registers a proxy across successive calls on a strict registry", () => {
    const tools = new Map<
      string,
      { name: string; description: string; toolSpec: unknown }
    >();
    const strictRegistry = {
      add(t: { name: string; description: string; toolSpec: unknown }) {
        if (tools.has(t.name)) {
          throw new Error(`Tool with name '${t.name}' already registered`);
        }
        tools.set(t.name, t);
      },
      get(name: string) {
        return tools.get(name);
      },
      remove(name: string) {
        tools.delete(name);
      },
      list() {
        return Array.from(tools.values());
      },
    };

    const first = syncProxyTools(
      strictRegistry as unknown as Parameters<typeof syncProxyTools>[0],
      [aguiTool("change_background")],
      new Set(),
    );
    expect(first).toEqual(new Set(["change_background"]));

    expect(() =>
      syncProxyTools(
        strictRegistry as unknown as Parameters<typeof syncProxyTools>[0],
        [aguiTool("change_background")],
        first,
      ),
    ).not.toThrow();
    expect(strictRegistry.list().length).toBe(1);
  });
});
