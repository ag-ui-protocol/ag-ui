// Type shapes vendored from @ai-sdk/ui-utils@1.2.11 (Apache-2.0, Copyright Vercel, Inc.),
// following Mastra's copy in @mastra/client-js:
// https://github.com/mastra-ai/mastra/pull/27297 (client-sdks/client-js/src/utils/ai-sdk-v4/types.ts
// at c56d026c5194b1977e5321f429565eedbccf2c40). Only the types parsePartialJson needs.

export type JSONValue =
  | null
  | string
  | number
  | boolean
  | { [value: string]: JSONValue }
  | Array<JSONValue>;
