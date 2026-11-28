import { describe, expect, it } from "vitest";
import jsonpatch, { type Operation } from "fast-json-patch";
import { describePatchFailure } from "@/patch-failure";

/** Applies `patch` to `document` and returns what fast-json-patch throws. */
function failure(document: unknown, patch: Operation[]): unknown {
  try {
    jsonpatch.applyPatch(document, patch, true, false);
  } catch (error) {
    return error;
  }
  throw new Error("expected the patch to fail");
}

describe("describePatchFailure", () => {
  it("drops the document and values that fast-json-patch puts in its message", () => {
    const patch: Operation[] = [{ op: "replace", path: "/missing/key", value: "patch-secret" }];
    const error = failure({ profile: { email: "doc-secret" } }, patch) as Error;
    // The library's own message carries both, which is why it can't be logged as is.
    expect(error.message).toContain("doc-secret");
    expect(error.message).toContain("patch-secret");

    expect(describePatchFailure(patch, error)).toBe(
      "OPERATION_PATH_UNRESOLVABLE: Cannot perform the operation at a path that does not exist (operation 1 of 1: replace /missing/key)",
    );
  });

  it.each([
    // A path error from the validator reports index 0 whichever operation failed.
    [
      "a missing path",
      [
        { op: "add", path: "/a", value: 1 },
        { op: "remove", path: "/nope" },
      ],
      2,
    ],
    [
      "a failed test",
      [
        { op: "add", path: "/a", value: 1 },
        { op: "test", path: "/a", value: 2 },
      ],
      2,
    ],
    [
      "an out-of-bounds index",
      [
        { op: "add", path: "/list", value: [] },
        { op: "add", path: "/list/5", value: 1 },
      ],
      2,
    ],
  ] as [string, Operation[], number][])(
    "names the operation that failed on %s",
    (_what, patch, failing) => {
      const description = describePatchFailure(patch, failure({}, patch));
      expect(description).toContain(`operation ${failing} of ${patch.length}: `);
      expect(description).toContain(`${patch[failing - 1].op} ${patch[failing - 1].path}`);
    },
  );

  it("points at the failing entry when a patch repeats an op and path", () => {
    const patch: Operation[] = [
      { op: "add", path: "/x", value: 1 },
      { op: "remove", path: "/x" },
      { op: "remove", path: "/x" },
    ];
    expect(describePatchFailure(patch, failure({}, patch))).toContain(
      "operation 3 of 3: remove /x",
    );
  });

  it("finds the operation by op and path when the caller passed a copy", () => {
    const patch: Operation[] = [
      { op: "add", path: "/a", value: 1 },
      { op: "remove", path: "/nope" },
    ];
    const error = failure({}, structuredClone(patch));
    expect(describePatchFailure(patch, error)).toContain("operation 2 of 2: remove /nope");
  });

  it("does not throw on a patch that is not an array", () => {
    const error = Object.assign(new Error("bad"), { operation: { op: "add", path: "/x" } });
    expect(describePatchFailure(null, error)).toBe("bad (operation: add /x)");
    expect(describePatchFailure({}, new Error("bad"))).toBe("bad (0 operations)");
  });

  it("does not echo something thrown that is not an Error", () => {
    expect(describePatchFailure([], "contains a secret")).toBe(
      "non-Error value thrown (0 operations)",
    );
  });

  it.each([
    ["a failed test", [{ op: "test", path: "/a", value: 2 }], "TEST_OPERATION_FAILED: "],
    [
      "an out-of-bounds index",
      [
        { op: "add", path: "/list", value: [] },
        { op: "add", path: "/list/5", value: 1 },
      ],
      "OPERATION_VALUE_OUT_OF_BOUNDS: ",
    ],
  ] as [string, Operation[], string][])(
    "starts with the library's error code for %s",
    (_what, patch, code) => {
      expect(describePatchFailure(patch, failure({ a: 1 }, patch))).toMatch(new RegExp(`^${code}`));
    },
  );

  it("does not prefix the generic name of a plain Error", () => {
    expect(describePatchFailure([], new TypeError("bad"))).toBe("TypeError: bad (0 operations)");
    expect(describePatchFailure([], new Error("bad"))).toBe("bad (0 operations)");
  });

  it("counts operations in the singular", () => {
    expect(describePatchFailure([{ op: "add", path: "/a" }], new Error("bad"))).toBe(
      "bad (1 operation)",
    );
  });
});
