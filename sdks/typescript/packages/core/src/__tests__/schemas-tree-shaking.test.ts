import { describe, expect, it } from "vitest";
import { build } from "esbuild";
// This package has no Node type dependency. Decode spaces and handle Windows
// drive letters/UNC paths without depending on the runner's working directory.
const testsUrl = new URL(".", import.meta.url);
const testsDir =
  (testsUrl.hostname ? `//${testsUrl.hostname}` : "") +
  decodeURIComponent(testsUrl.pathname).replace(/^\/(?=[A-Za-z]:\/)/, "");

type ParseResult = {
  success: boolean;
  error?: { issues: { message: string }[] };
};

async function bundle(contents: string) {
  const result = await build({
    stdin: { contents, resolveDir: testsDir },
    bundle: true,
    minify: true,
    platform: "browser",
    format: "iife",
    globalName: "bundle",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const retained = Object.values(result.metafile.outputs)
    .flatMap((output) => Object.entries(output.inputs))
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([path]) => path.replace(/\\/g, "/"));
  // Inspect emitted bytes, not modules merely visited by the bundler.
  // Lazy imports can retain the locales barrel's initialization wrapper.
  expect(retained.some((path) => path.includes("/node_modules/zod/"))).toBe(true);
  expect(
    retained.filter(
      (path) => /\/locales\/[^/]+\.js$/.test(path) && !/\/locales\/(?:en|index)\.js$/.test(path),
    ),
  ).toEqual([]);
  return new Function(`${result.outputFiles[0].text}\nreturn bundle;`)() as {
    parse: (value: unknown) => ParseResult;
    parsed: Promise<ParseResult>;
    restore: () => void;
  };
}

const invalidEvent = { type: "TEXT_MESSAGE_CONTENT", messageId: 1, delta: "x" };

describe("schema tree-shaking", () => {
  it("drops unused locales while preserving English issue messages", async () => {
    const { parse } = await bundle(`
      import { TextMessageContentEventSchema } from "../schemas";
      export const parse = (value) => TextMessageContentEventSchema.safeParse(value);
    `);
    expect(parse({ ...invalidEvent, messageId: "m1" }).success).toBe(true);
    const parsed = parse(invalidEvent);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toMatch(/^Invalid input: expected string/);
  });

  it("preserves a locale configured before the schemas load", async () => {
    const { parsed, restore } = await bundle(`
      import * as z from "zod/v4";
      // Newer Zod shares this configuration across copies in the process.
      const previous = z.config().localeError;
      z.config({ localeError: () => "custom locale" });
      export const restore = () => z.config({ localeError: previous });
      export const parsed = import("../schemas").then(({ TextMessageContentEventSchema }) =>
        TextMessageContentEventSchema.safeParse(${JSON.stringify(invalidEvent)})
      );
    `);
    try {
      const result = await parsed;
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("custom locale");
    } finally {
      restore();
    }
  });
});
