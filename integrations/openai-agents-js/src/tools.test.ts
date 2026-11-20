/**
 * Tests for tool conversion (`src/tools.ts`).
 *
 * These exercise the pure conversion logic without the SDK runtime: a fake
 * `ToolModule.tool` records the options passed in so we can assert the AG-UI
 * tool → SDK FunctionTool mapping, JSON-Schema normalisation, and
 * `ag_ui_update_state` injection.
 */

import { describe, it, expect } from "vitest";

import { STATE_MANAGEMENT_TOOL_NAME } from "./config";
import {
  buildTools,
  convertAguiToolToOpenAi,
  createStateManagementTool,
  normalizeParameters,
  STUB_TOOL_RESULT,
} from "./tools";

/**
 * Fake `ToolModule`: `tool` echoes its options as a plain object tagged with
 * `__mockTool` so tests can assert the conversion output.
 */
function fakeMod() {
  const calls: Record<string, unknown>[] = [];
  const mod = {
    tool(options: Record<string, unknown>) {
      calls.push(options);
      return {
        name: options.name,
        description: options.description,
        parameters: options.parameters,
        strict: options.strict,
        execute: options.execute,
        __mockTool: true,
      };
    },
  };
  return { mod, calls };
}

describe("normalizeParameters", () => {
  it("coerces a full JSON Schema into the SDK non-strict shape", () => {
    const schema = normalizeParameters({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    });
    expect(schema).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: true,
      description: undefined,
    });
  });

  it("defaults properties/required when missing", () => {
    const schema = normalizeParameters({});
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({});
    expect(schema.required).toEqual([]);
    expect(schema.additionalProperties).toBe(true);
  });

  it("coerces non-object / undefined input to an empty object schema", () => {
    expect(normalizeParameters(undefined)).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
      description: undefined,
    });
    expect(normalizeParameters("not-an-object")).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
      description: undefined,
    });
  });

  it("preserves description and filters non-string required entries", () => {
    const schema = normalizeParameters({
      description: "weather lookup",
      properties: { q: { type: "string" } },
      required: ["q", 42, null] as unknown as string[],
    });
    expect(schema.description).toBe("weather lookup");
    expect(schema.required).toEqual(["q"]);
  });
});

describe("convertAguiToolToOpenAi", () => {
  it("passes name/description through and creates a non-strict tool", () => {
    const { mod, calls } = fakeMod();
    const t = convertAguiToolToOpenAi(
      { name: "get_weather", description: "Get the weather", parameters: {} },
      mod,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: "get_weather",
      description: "Get the weather",
      strict: false,
    });
    expect((t as { __mockTool: boolean }).__mockTool).toBe(true);
  });

  it("normalises the parameters to the SDK non-strict shape", () => {
    const { mod, calls } = fakeMod();
    convertAguiToolToOpenAi(
      {
        name: "search",
        description: "search things",
        parameters: { properties: { q: { type: "string" } }, required: ["q"] },
      },
      mod,
    );
    expect(calls[0].parameters).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
      additionalProperties: true,
      description: undefined,
    });
  });

  it("defaults a missing tool name to 'tool' and description to ''", () => {
    const { mod, calls } = fakeMod();
    convertAguiToolToOpenAi({ parameters: {} }, mod);
    expect(calls[0].name).toBe("tool");
    expect(calls[0].description).toBe("");
  });

  it("wires a stub execute that resolves to the placeholder result", async () => {
    const { mod, calls } = fakeMod();
    convertAguiToolToOpenAi({ name: "t", description: "d", parameters: {} }, mod);
    const execute = calls[0].execute as (...args: unknown[]) => unknown;
    await expect(Promise.resolve(execute({}))).resolves.toBe(STUB_TOOL_RESULT);
  });
});

describe("createStateManagementTool", () => {
  it("creates a tool named ag_ui_update_state in non-strict mode", () => {
    const { mod, calls } = fakeMod();
    createStateManagementTool(mod);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: STATE_MANAGEMENT_TOOL_NAME,
      strict: false,
    });
    expect(typeof calls[0].description).toBe("string");
  });

  it("declares a required `state` object parameter (replace semantics)", () => {
    const { mod, calls } = fakeMod();
    createStateManagementTool(mod);
    const params = calls[0].parameters as Record<string, unknown>;
    expect(params.type).toBe("object");
    expect(params.required).toEqual(["state"]);
    expect((params.properties as Record<string, unknown>).state).toMatchObject({
      type: "object",
      additionalProperties: true,
    });
  });

  it("wires a stub execute", async () => {
    const { mod, calls } = fakeMod();
    createStateManagementTool(mod);
    const execute = calls[0].execute as (...args: unknown[]) => unknown;
    await expect(Promise.resolve(execute({}))).resolves.toBe(STUB_TOOL_RESULT);
  });
});

describe("buildTools", () => {
  it("converts every AG-UI tool and appends the state tool when state is present", () => {
    const { mod, calls } = fakeMod();
    const tools = buildTools(
      {
        tools: [
          { name: "get_weather", description: "w", parameters: {} },
          { name: "search", description: "s", parameters: {} },
        ],
        state: { count: 0 },
      },
      mod,
    );
    expect(tools).toHaveLength(3);
    // First two are the converted frontend tools.
    expect((tools[0] as { name: string }).name).toBe("get_weather");
    expect((tools[1] as { name: string }).name).toBe("search");
    // Third is the injected state tool.
    expect((tools[2] as { name: string }).name).toBe(STATE_MANAGEMENT_TOOL_NAME);
    expect(calls).toHaveLength(3);
  });

  it("does NOT inject the state tool when state is null/undefined", () => {
    const { mod, calls } = fakeMod();
    const tools = buildTools(
      { tools: [{ name: "t", description: "d", parameters: {} }], state: null },
      mod,
    );
    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe("t");
    expect(calls).toHaveLength(1);
  });

  it("injects the state tool when state is an empty object ({} is active state)", () => {
    const { mod } = fakeMod();
    const tools = buildTools({ tools: [], state: {} }, mod);
    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe(STATE_MANAGEMENT_TOOL_NAME);
  });

  it("returns an empty list when there are no tools and no state", () => {
    const { mod } = fakeMod();
    expect(buildTools({}, mod)).toEqual([]);
    expect(buildTools({ tools: [], state: undefined }, mod)).toEqual([]);
  });

  it("skips non-object tool entries", () => {
    const { mod, calls } = fakeMod();
    const tools = buildTools(
      {
        tools: [
          null,
          42,
          { name: "valid", description: "v", parameters: {} },
        ] as unknown[],
        state: null,
      },
      mod,
    );
    expect(tools).toHaveLength(1);
    expect((tools[0] as { name: string }).name).toBe("valid");
    expect(calls).toHaveLength(1);
  });
});
