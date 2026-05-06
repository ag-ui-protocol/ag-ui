import { describe, expect, it } from "vitest";
import { fromStandardSchema } from "../validator";
import type { StandardSchemaV1 } from "@standard-schema/spec";

const makeSchema = <T>(
  validate: StandardSchemaV1<unknown, T>["~standard"]["validate"],
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate,
  },
});

describe("fromStandardSchema", () => {
  it("returns success when the underlying schema returns a value", () => {
    const schema = makeSchema<number>((input) => ({ value: 42 }));
    const validator = fromStandardSchema(schema);
    const result = validator("anything");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe(42);
    }
  });

  it("returns failure with mapped issues when the underlying schema returns issues", () => {
    const schema = makeSchema<unknown>((input) => ({
      issues: [
        { message: "bad", path: ["a", { key: "b" }, 0] },
      ],
    }));
    const validator = fromStandardSchema(schema);
    const result = validator("anything");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.message).toBe("bad");
      expect(result.issues[0]?.path).toEqual(["a", "b", "0"]);
    }
  });

  it("treats an empty issues array as success", () => {
    const schema = makeSchema<string>((input) => ({
      value: "ok",
      issues: [],
    } as ReturnType<StandardSchemaV1<unknown, string>["~standard"]["validate"]>));
    const validator = fromStandardSchema(schema);
    const result = validator("anything");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toBe("ok");
    }
  });

  it("throws when the schema returns a Promise", () => {
    const schema = makeSchema<unknown>((input) =>
      Promise.resolve({ value: input }),
    );
    const validator = fromStandardSchema(schema);
    expect(() => validator("anything")).toThrowError(
      /does not support async/i,
    );
  });
});
