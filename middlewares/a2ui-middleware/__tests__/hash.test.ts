import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash";

// Synthetic action IDs are stored in thread history, so the edge-safe hash
// must stay byte-identical to the node:crypto output it replaced.
describe("sha256Hex", () => {
  it.each([
    { name: "empty", input: "" },
    { name: "ASCII", input: "run-123" },
    { name: "UUID", input: "6f9619ff-8b86-d011-b42d-00cf4fc964ff" },
    { name: "Latin-1", input: "café ñandú" },
    { name: "CJK", input: "你好，世界" },
    { name: "emoji", input: "😀👍🏽🇧🇦" },
    { name: "lone surrogate", input: "a\ud800b" },
    { name: "control characters", input: "\u0000\t\n\r" },
    { name: "one block boundary", input: "a".repeat(55) },
    { name: "two block boundary", input: "a".repeat(64) },
    { name: "long", input: "x".repeat(100_000) },
  ])("matches node:crypto for $name input", ({ input }) => {
    expect(sha256Hex(input)).toBe(
      createHash("sha256").update(input).digest("hex"),
    );
  });
});
