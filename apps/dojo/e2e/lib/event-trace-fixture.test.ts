import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertFixtureMaterialized } from "./event-trace-fixture";

async function withFixture(
  contents: string | Uint8Array,
  verify: (path: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "event-trace-fixture-test-"));
  const path = join(directory, "test-image.png");
  try {
    await writeFile(path, contents);
    await verify(path);
  } finally {
    await rm(directory, { recursive: true });
  }
}

test("rejects a Git LFS pointer before recording an event trace", async () => {
  await withFixture(
    [
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:deadbeef",
      "size 70",
      "",
    ].join("\n"),
    async (path) => {
      await assert.rejects(
        assertFixtureMaterialized(path),
        /Git LFS pointer.*git lfs pull/s,
      );
    },
  );
});

test("accepts a materialized binary fixture", async () => {
  await withFixture(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), async (path) => {
    await assert.doesNotReject(assertFixtureMaterialized(path));
  });
});
