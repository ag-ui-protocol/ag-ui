// Vendored from @ai-sdk/ui-utils@1.2.11 (Apache-2.0, Copyright Vercel, Inc.), following
// Mastra's copy in @mastra/client-js:
// https://github.com/mastra-ai/mastra/pull/27297 (client-sdks/client-js/src/utils/ai-sdk-v4/parse-partial-json.ts
// at c56d026c5194b1977e5321f429565eedbccf2c40).
//
// Like Mastra's copy, it parses with JSON.parse instead of @ai-sdk/provider-utils'
// safeParseJSON, so it needs no AI SDK package. It stays synchronous, matching the
// ui-utils function it replaces, so the chunk pipeline that calls it is unchanged.
// See https://github.com/ag-ui-protocol/ag-ui/issues/3096 and
// https://github.com/ag-ui-protocol/ag-ui/issues/2874.
//
// Unlike Mastra's copy, tryParse keeps the rules safeParseJSON applied through
// secure-json-parse's defaults: a leading BOM is stripped, and any `__proto__` key
// or `constructor` object with its own `prototype` property is rejected. The parsed
// working memory is merged into shared state, so those keys must not get through.
import { fixJson } from "./fix-json";
import type { JSONValue } from "./types";

function tryParse(
  text: string,
): { success: true; value: JSONValue } | { success: false } {
  try {
    const value = JSON.parse(
      text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
      (key, value: unknown) => {
        if (
          key === "__proto__" ||
          (key === "constructor" &&
            value !== null &&
            typeof value === "object" &&
            Object.prototype.hasOwnProperty.call(value, "prototype"))
        ) {
          throw new SyntaxError("Object contains forbidden prototype property");
        }
        return value;
      },
    ) as JSONValue;
    return { success: true, value };
  } catch {
    return { success: false };
  }
}

export function parsePartialJson(jsonText: string | undefined): {
  value: JSONValue | undefined;
  state:
    | "undefined-input"
    | "successful-parse"
    | "repaired-parse"
    | "failed-parse";
} {
  if (jsonText === undefined) {
    return { value: undefined, state: "undefined-input" };
  }

  let result = tryParse(jsonText);
  if (result.success) {
    return { value: result.value, state: "successful-parse" };
  }

  result = tryParse(fixJson(jsonText));
  if (result.success) {
    return { value: result.value, state: "repaired-parse" };
  }

  return { value: undefined, state: "failed-parse" };
}
