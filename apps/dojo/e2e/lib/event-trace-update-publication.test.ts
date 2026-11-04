import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { publishEventTraceUpdates } from "./event-trace-update-publication";
import { withEventTraceUpdateWorkspace } from "./event-trace-update-workspace";

async function createPublication(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "event-trace-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ["first", "second", "third"].map((name) => join(root, name));
  await Promise.all(
    paths.map((path, index) => writeFile(path, `original-${index}`)),
  );
  const stagingRoot = join(root, ".event-trace-update");
  let stagingDirectory = "";
  return {
    paths,
    stagingRoot,
    directory: () => stagingDirectory,
    contents: () => Promise.all(paths.map((path) => readFile(path, "utf8"))),
    publish: (replace = rename, empty = false) =>
      withEventTraceUpdateWorkspace(stagingRoot, async (workspace) => {
        stagingDirectory = workspace.stagingDirectory;
        await workspace.publish(() =>
          publishEventTraceUpdates(
            empty
              ? []
              : paths.map((path, index) => ({
                  path,
                  temporaryPath: join(stagingDirectory, `golden-${index}.tmp`),
                  content: `updated-${index}`,
                })),
            stagingDirectory,
            replace,
          ),
        );
      }),
  };
}

for (const failurePosition of [1, 2, 3]) {
  test(`restores all originals when replacement ${failurePosition} fails`, async (t) => {
    const fixture = await createPublication(t);
    const failure = new Error(`replacement ${failurePosition} failed`);
    let calls = 0;
    await assert.rejects(
      fixture.publish(async (source, destination) => {
        if (++calls === failurePosition) throw failure;
        await rename(source, destination);
      }),
      (error) => error === failure,
    );
    assert.deepEqual(await fixture.contents(), [
      "original-0",
      "original-1",
      "original-2",
    ]);
    assert.deepEqual(await readdir(fixture.stagingRoot), []);
  });
}

for (const failurePosition of [2, 3]) {
  test(`rollback failure after replacement ${failurePosition} retains usable originals and reports both failures`, async (t) => {
    const fixture = await createPublication(t);
    const publicationFailure = new Error(
      `replacement ${failurePosition} failed`,
    );
    const rollbackFailure = new Error("original restoration failed");
    let calls = 0;
    await assert.rejects(
      fixture.publish(async (source, destination) => {
        calls += 1;
        if (calls === failurePosition) throw publicationFailure;
        if (calls === failurePosition + 1) throw rollbackFailure;
        await rename(source, destination);
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, publicationFailure);
        assert.deepEqual(error.errors, [publicationFailure, rollbackFailure]);
        assert.ok(error.message.includes(publicationFailure.message));
        assert.match(error.message, /original restoration failed/);
        assert.ok(error.message.includes(fixture.directory()));
        return true;
      },
    );
    assert.deepEqual(await readdir(fixture.stagingRoot), [
      basename(fixture.directory()),
    ]);
    assert.deepEqual(
      await fixture.contents(),
      failurePosition === 2
        ? ["updated-0", "original-1", "original-2"]
        : ["original-0", "updated-1", "original-2"],
    );
    const recovery = JSON.parse(
      await readFile(join(fixture.directory(), "recovery.json"), "utf8"),
    );
    assert.deepEqual(
      recovery,
      fixture.paths.map((path, index) => ({
        path,
        backupPath: join(fixture.directory(), `original-${index}.bak`),
      })),
    );
    for (const [index, path] of fixture.paths.entries()) {
      const backup = join(fixture.directory(), `original-${index}.bak`);
      assert.equal(await readFile(backup, "utf8"), `original-${index}`);
      await rename(backup, path);
    }
    assert.deepEqual(await fixture.contents(), [
      "original-0",
      "original-1",
      "original-2",
    ]);
  });
}

for (const fail of [false, true]) {
  test(`new baseline is ${fail ? "removed on rollback" : "published successfully"}`, async (t) => {
    const fixture = await createPublication(t);
    await rm(fixture.paths[0]);
    const failure = new Error("second replacement failed");
    let calls = 0;
    const publication = fixture.publish(async (source, destination) => {
      if (++calls === 2 && fail) throw failure;
      await rename(source, destination);
    });
    if (fail) {
      await assert.rejects(publication, (error) => error === failure);
      await assert.rejects(readFile(fixture.paths[0]), { code: "ENOENT" });
      assert.equal(await readFile(fixture.paths[1], "utf8"), "original-1");
      assert.equal(await readFile(fixture.paths[2], "utf8"), "original-2");
    } else {
      await publication;
      assert.deepEqual(await fixture.contents(), [
        "updated-0",
        "updated-1",
        "updated-2",
      ]);
    }
    assert.deepEqual(await readdir(fixture.stagingRoot), []);
  });
}

for (const empty of [false, true]) {
  test(
    empty
      ? "empty publication is a no-op"
      : "publishes every replacement successfully",
    async (t) => {
      const fixture = await createPublication(t);
      await fixture.publish(rename, empty);
      const prefix = empty ? "original" : "updated";
      assert.deepEqual(
        await fixture.contents(),
        [0, 1, 2].map((index) => `${prefix}-${index}`),
      );
      assert.deepEqual(await readdir(fixture.stagingRoot), []);
    },
  );
}
