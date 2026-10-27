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

describe("fixJson (vendored)", () => {
  it("closes open strings, arrays and objects", () => {
    expect(JSON.parse(fixJson('{"a":"he'))).toEqual({ a: "he" });
    expect(JSON.parse(fixJson('{"a":['))).toEqual({ a: [] });
    expect(JSON.parse(fixJson('{"a":"x\\"y'))).toEqual({ a: 'x"y' });
  });
});
