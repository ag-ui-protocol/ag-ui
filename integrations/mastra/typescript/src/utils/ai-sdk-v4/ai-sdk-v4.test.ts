import { parsePartialJson } from ".";
import { fixJson } from "./fix-json";

// The vendored parser replaces @ai-sdk/ui-utils' parsePartialJson (#3096, #2874),
// following Mastra's copy in https://github.com/mastra-ai/mastra/pull/27297.
// The first case is Mastra's own test; the rest pin the shapes the working-memory
// streaming bridge in mastra.ts feeds it.

describe("parsePartialJson (vendored)", () => {
  it("reports each parse state (Mastra's test case)", () => {
    expect(parsePartialJson(undefined)).toEqual({
      value: undefined,
      state: "undefined-input",
    });
    expect(parsePartialJson('{"a":1}')).toEqual({
      value: { a: 1 },
      state: "successful-parse",
    });
    expect(parsePartialJson('{"a":[1,"tw')).toEqual({
      value: { a: [1, "tw"] },
      state: "repaired-parse",
    });
    expect(parsePartialJson("}{")).toEqual({
      value: undefined,
      state: "failed-parse",
    });
  });

  it("is synchronous", () => {
    expect(parsePartialJson('{"a":1}')).not.toBeInstanceOf(Promise);
  });

  it("repairs the streamed working-memory envelope and its nested JSON string", () => {
    const outer = parsePartialJson(
      '{"memory":"{\\"recipe\\":{\\"title\\":\\"Sp',
    );
    expect(outer.state).toBe("repaired-parse");
    const memory = (outer.value as { memory: string }).memory;
    expect(parsePartialJson(memory).value).toEqual({
      recipe: { title: "Sp" },
    });
  });

  it("repairs dangling keys, literals and numbers", () => {
    expect(parsePartialJson('{"memory":').value).toEqual({});
    expect(parsePartialJson('{"done":tr').value).toEqual({ done: true });
    expect(parsePartialJson('{"a":1,"b":').value).toEqual({ a: 1 });
  });
});

// @ai-sdk/ui-utils parsed through @ai-sdk/provider-utils' safeParseJSON, which
// uses secure-json-parse with its defaults: a leading BOM is stripped, and any
// `__proto__` key or `constructor` object with its own `prototype` is rejected.
// The vendored parser keeps those rules; a rejection is a failed parse.
describe("parsePartialJson (vendored) keeps secure-json-parse's rules", () => {
  const failed = { value: undefined, state: "failed-parse" };

  it("rejects a __proto__ key in complete input", () => {
    expect(parsePartialJson('{"__proto__":{"polluted":true}}')).toEqual(failed);
    expect(parsePartialJson('{"a":1,"__proto__":null}')).toEqual(failed);
  });

  it("rejects a __proto__ key in input that needs repair", () => {
    expect(parsePartialJson('{"__proto__":{"polluted":tr')).toEqual(failed);
    expect(parsePartialJson('{"a":"x","__proto__":{')).toEqual(failed);
  });

  it("rejects a nested __proto__ key", () => {
    expect(
      parsePartialJson('{"recipe":{"steps":[{"__proto__":{"x":1}}]}}'),
    ).toEqual(failed);
    expect(parsePartialJson('{"recipe":{"meta":{"__proto__":{"x":1')).toEqual(
      failed,
    );
  });

  it("rejects a Unicode-escaped __proto__ key", () => {
    expect(
      parsePartialJson('{"\\u005f\\u005fproto\\u005f\\u005f":{"x":1}}'),
    ).toEqual(failed);
    expect(parsePartialJson('{"\\u005f_proto__":{"x":1')).toEqual(failed);
  });

  it("rejects a constructor object with its own prototype", () => {
    expect(parsePartialJson('{"constructor":{"prototype":{"x":1}}}')).toEqual(
      failed,
    );
    expect(parsePartialJson('{"a":{"constructor":{"prototype":{"x":1')).toEqual(
      failed,
    );
    expect(
      parsePartialJson('{"\\u0063onstructor":{"prototyp\\u0065":null}}'),
    ).toEqual(failed);
  });

  it("does not pollute Object.prototype", () => {
    parsePartialJson('{"__proto__":{"polluted":true}}');
    parsePartialJson('{"__proto__":{"polluted":tr');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps ordinary constructor and prototype fields valid", () => {
    expect(parsePartialJson('{"constructor":"Recipe"}')).toEqual({
      value: { constructor: "Recipe" },
      state: "successful-parse",
    });
    expect(parsePartialJson('{"constructor":{"name":"Recipe"}}')).toEqual({
      value: { constructor: { name: "Recipe" } },
      state: "successful-parse",
    });
    // secure-json-parse 2.7.0 failed this one by accident (hasOwnProperty on
    // null throws a TypeError); a null constructor carries no prototype.
    expect(parsePartialJson('{"constructor":null}')).toEqual({
      value: { constructor: null },
      state: "successful-parse",
    });
    expect(parsePartialJson('{"prototype":{"constructor":"x"}}')).toEqual({
      value: { prototype: { constructor: "x" } },
      state: "successful-parse",
    });
    expect(parsePartialJson('{"proto":1,"__proto":2,"proto__":3}')).toEqual({
      value: { proto: 1, __proto: 2, proto__: 3 },
      state: "successful-parse",
    });
    expect(parsePartialJson('{"constructor":{"name":"Rec')).toEqual({
      value: { constructor: { name: "Rec" } },
      state: "repaired-parse",
    });
  });

  it("keeps __proto__ and constructor as string values valid", () => {
    expect(parsePartialJson('{"key":"__proto__","t":"constructor"}')).toEqual({
      value: { key: "__proto__", t: "constructor" },
      state: "successful-parse",
    });
  });

  it("strips a leading BOM", () => {
    expect(parsePartialJson('\uFEFF{"a":1}')).toEqual({
      value: { a: 1 },
      state: "successful-parse",
    });
    expect(parsePartialJson('\uFEFF{"a":[1,"tw')).toEqual({
      value: { a: [1, "tw"] },
      state: "repaired-parse",
    });
  });
});

describe("fixJson (vendored)", () => {
  it("closes open strings, arrays and objects", () => {
    expect(JSON.parse(fixJson('{"a":"he'))).toEqual({ a: "he" });
    expect(JSON.parse(fixJson('{"a":['))).toEqual({ a: [] });
    expect(JSON.parse(fixJson('{"a":"x\\"y'))).toEqual({ a: 'x"y' });
  });
});
