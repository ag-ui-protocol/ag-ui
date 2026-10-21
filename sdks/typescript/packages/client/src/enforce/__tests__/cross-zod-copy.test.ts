import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
// A second, independently installed zod: this package's devDependency alias
// `zod-v4-copy` (npm:zod@^4). It resolves to its own directory in the store,
// so its classes are distinct module instances from the `zod/v4` entry point
// of the zod 3.25 line that strip.ts imports.
import { z as foreignZ } from "zod-v4-copy/v4";
import foreignZodPackage from "zod-v4-copy/package.json";
import { stripUnknown } from "../strip";

/**
 * Two zod copies in one process is the normal case, not the exotic one: an
 * application installs its own zod, `@ag-ui/core` declares zod as an optional
 * peer, and any hoisting accident or version skew lands a second copy in
 * node_modules. `stripUnknown` narrows entirely by `instanceof z.ZodObject` /
 * `z.ZodArray` / `z.ZodUnion`, so if `instanceof` were copy-local it would
 * silently strip nothing at all against a foreign schema — a no-op with no
 * error, which is the worst failure mode this layer can have.
 *
 * It is not copy-local: zod v4 builds every class through `$constructor`,
 * which installs a `Symbol.hasInstance` that tests a trait set carried on the
 * instance instead of walking the prototype chain. This test pins that, using
 * two real installed copies rather than a mock, because the property being
 * relied on belongs to zod and only zod can break it.
 *
 * It also pins the corollary that motivated hiding `stripUnknown` from the
 * public API: `stripUnknown(value, schema)` NAMES a zod type in its signature,
 * so exporting it makes zod part of this package's contract even though the
 * runtime behaviour survives a second copy just fine.
 */

describe("stripUnknown across two zod copies", () => {
  it("the foreign copy really is a separate zod install", () => {
    // If the alias ever collapsed onto this package's own zod (for example a
    // workspace-wide `zod` override catching it) the tests below would pass
    // vacuously, so the precondition is asserted rather than assumed.
    expect(foreignZodPackage.version).toMatch(/^4\./);
    expect(foreignZ.ZodObject).not.toBe(z.ZodObject);
  });

  it("a schema built by one copy is an instanceof the other copy's classes", () => {
    // The direction stripUnknown relies on: a foreign schema checked against
    // this package's classes.
    expect(foreignZ.looseObject({ id: foreignZ.string() }) instanceof z.ZodObject).toBe(true);
    expect(foreignZ.array(foreignZ.string()) instanceof z.ZodArray).toBe(true);
    expect(
      foreignZ.union([foreignZ.string(), foreignZ.array(foreignZ.string())]) instanceof z.ZodUnion,
    ).toBe(true);

    // And the reverse, so the property is not an accident of one version.
    expect(z.looseObject({ id: z.string() }) instanceof foreignZ.ZodObject).toBe(true);
    expect(z.array(z.string()) instanceof foreignZ.ZodArray).toBe(true);
    expect(z.union([z.string(), z.array(z.string())]) instanceof foreignZ.ZodUnion).toBe(true);
  });

  it("strips against a schema this package did not build", () => {
    // strip.ts imported `zod/v4` from this package, so the `z` in scope here
    // IS that copy, and `foreignZ` is not.
    const schema = foreignZ.looseObject({
      id: foreignZ.string(),
      parts: foreignZ.array(foreignZ.looseObject({ kind: foreignZ.string() })),
    });
    const { value, stripped } = stripUnknown(
      {
        id: "m1",
        surprise: "from the future",
        parts: [{ kind: "text", alsoSurprise: 1 }],
      },
      schema as unknown as z.ZodType,
    );
    expect(stripped).toEqual(["/surprise", "/parts/0/alsoSurprise"]);
    expect(value).toEqual({ id: "m1", parts: [{ kind: "text" }] });
  });
});
