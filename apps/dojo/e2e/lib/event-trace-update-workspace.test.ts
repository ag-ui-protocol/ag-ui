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
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  EventTracePublicationRecoveryError,
  publishEventTraceUpdates,
} from "./event-trace-update-publication";
import { withEventTraceUpdateWorkspace } from "./event-trace-update-workspace";

async function createWorkspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "event-trace-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stagingRoot: join(root, ".event-trace-update") };
}

function signal() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

test("interleaved captures retain only their own candidates and clean up independently", async (t) => {
  const { root, stagingRoot } = await createWorkspace(t);
  const captured = signal();
  const resume = signal();
  const paths: string[] = [];
  async function capture(name: string, pause: boolean) {
    return withEventTraceUpdateWorkspace(
      stagingRoot,
      async ({ stagingDirectory, publish }) => {
        paths.push(stagingDirectory);
        await writeFile(
          join(stagingDirectory, "candidate.json"),
          JSON.stringify(name),
        );
        if (pause) {
          captured.release();
          await resume.ready;
        }
        const files = await readdir(stagingDirectory);
        assert.deepEqual(files, ["candidate.json"]);
        const candidate = await readFile(
          join(stagingDirectory, files[0]),
          "utf8",
        );
        assert.equal(candidate, JSON.stringify(name));
        await publish(async () => {
          const temporaryPath = join(stagingDirectory, "golden.tmp");
          await writeFile(temporaryPath, candidate);
          await rename(temporaryPath, join(root, `${name}.golden`));
        });
      },
    );
  }
  const first = capture("first", true);
  await captured.ready;
  try {
    await capture("second", false);
  } finally {
    resume.release();
  }
  await first;
  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(await readdir(stagingRoot), []);
  assert.equal(await readFile(join(root, "first.golden"), "utf8"), '"first"');
  assert.equal(await readFile(join(root, "second.golden"), "utf8"), '"second"');
});

test("publication contention preserves the lock owner's files", async (t) => {
  const { stagingRoot } = await createWorkspace(t);
  const locked = signal();
  const resume = signal();
  const first = withEventTraceUpdateWorkspace(
    stagingRoot,
    async ({ stagingDirectory, publish }) => {
      await writeFile(join(stagingDirectory, "golden.tmp"), "first");
      await publish(async () => {
        locked.release();
        await resume.ready;
        assert.equal(
          await readFile(join(stagingDirectory, "golden.tmp"), "utf8"),
          "first",
        );
      });
    },
  );
  await locked.ready;
  try {
    await assert.rejects(
      withEventTraceUpdateWorkspace(stagingRoot, async ({ publish }) => {
        await publish(async () =>
          assert.fail("contending writer must not publish"),
        );
      }),
      /Another Event trace update is publishing/,
    );
    assert.equal((await readdir(stagingRoot)).length, 2);
  } finally {
    resume.release();
  }
  await first;
  assert.deepEqual(await readdir(stagingRoot), []);
});

for (const phase of ["capture", "publication"] as const) {
  test(`cleans invocation files after ${phase} failure and permits the next publication`, async (t) => {
    const { stagingRoot } = await createWorkspace(t);
    const failure = new Error(`${phase} failed`);
    await assert.rejects(
      withEventTraceUpdateWorkspace(
        stagingRoot,
        async ({ stagingDirectory, publish }) => {
          await writeFile(join(stagingDirectory, "partial.tmp"), "incomplete");
          if (phase === "capture") throw failure;
          await publish(async () => {
            throw failure;
          });
        },
      ),
      (error) => error === failure,
    );
    assert.deepEqual(await readdir(stagingRoot), []);
    await withEventTraceUpdateWorkspace(stagingRoot, async ({ publish }) =>
      publish(async () => {}),
    );
    assert.deepEqual(await readdir(stagingRoot), []);
  });
}

// Inject only cleanup operations; acquisition and publication use real temp files.
type CleanupStage = "close" | "lock" | "staging";
async function cleanupScenario(
  t: TestContext,
  failures: Partial<Record<CleanupStage, unknown>>,
  primary: { phase: "capture" | "publication"; error: unknown } | undefined,
) {
  const { stagingRoot } = await createWorkspace(t);
  const attempts: CleanupStage[] = [];
  const cleanup = async (stage: CleanupStage, action: () => Promise<void>) => {
    attempts.push(stage);
    await action();
    if (Object.hasOwn(failures, stage)) throw failures[stage];
  };
  const result = withEventTraceUpdateWorkspace(
    stagingRoot,
    async ({ publish }) => {
      if (primary?.phase === "capture") throw primary.error;
      return publish(async () => {
        if (primary) throw primary.error;
        return "published";
      });
    },
    {
      closeLock: (lock) => cleanup("close", () => lock.close()),
      remove: (path, options) =>
        cleanup(options?.recursive ? "staging" : "lock", () =>
          rm(path, options),
        ),
    },
  );
  return { result, attempts, stagingRoot };
}

for (const stage of ["close", "lock", "staging"] as const) {
  test(`keeps ${stage} cleanup failure observable and continues independent cleanup`, async (t) => {
    const failure = new Error(`${stage} cleanup failed`);
    const { result, attempts, stagingRoot } = await cleanupScenario(
      t,
      { [stage]: failure },
      undefined,
    );
    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(attempts, ["close", "lock", "staging"]);
    assert.deepEqual(await readdir(stagingRoot), []);
  });
}

for (const phase of ["capture", "publication"] as const) {
  test(`retains ${phase} error first alongside all cleanup failures`, async (t) => {
    const primary = new Error(`${phase} failed`);
    const close = new Error("close failed");
    const lock = new Error("lock removal failed");
    const staging = new Error("staging removal failed");
    const { result, attempts } = await cleanupScenario(
      t,
      { close, lock, staging },
      { phase, error: primary },
    );
    await assert.rejects(result, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(
        error.errors,
        phase === "capture"
          ? [primary, staging]
          : [primary, close, lock, staging],
      );
      return true;
    });
    assert.deepEqual(
      attempts,
      phase === "capture" ? ["staging"] : ["close", "lock", "staging"],
    );
  });
}

for (const primary of [undefined, null, false]) {
  test(`preserves thrown ${String(primary)} without using truthiness`, async (t) => {
    const { result } = await cleanupScenario(
      t,
      {},
      { phase: "publication", error: primary },
    );
    await result.then(
      () => assert.fail("must reject"),
      (error: unknown) => assert.equal(error, primary),
    );
    const cleanupFailure = new Error("cleanup failed");
    const combined = await cleanupScenario(
      t,
      { staging: cleanupFailure },
      { phase: "capture", error: primary },
    );
    await assert.rejects(combined.result, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.deepEqual(error.errors, [primary, cleanupFailure]);
      return true;
    });
  });
}

test("returns the capture result after successful cleanup", async (t) => {
  const { result, attempts } = await cleanupScenario(t, {}, undefined);
  assert.equal(await result, "published");
  assert.deepEqual(attempts, ["close", "lock", "staging"]);
});

test("aggregates multiple cleanup-only failures in attempted order", async (t) => {
  const failures = {
    close: new Error("close"),
    lock: new Error("lock"),
    staging: new Error("staging"),
  };
  const { result, attempts } = await cleanupScenario(t, failures, undefined);
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, Object.values(failures));
    assert.equal(error.cause, failures.close);
    return true;
  });
  assert.deepEqual(attempts, ["close", "lock", "staging"]);
});

test("retains publication recovery backups when lock cleanup also fails", async (t) => {
  const { root, stagingRoot } = await createWorkspace(t);
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  await writeFile(first, "original first");
  await writeFile(second, "original second");
  const publicationFailure = new Error("publication failed");
  const rollbackFailure = new Error("rollback failed");
  const closeFailure = new Error("close failed");
  const removeFailure = new Error("remove failed");
  const attempts: string[] = [];
  let recoveryDirectory = "";
  await assert.rejects(
    withEventTraceUpdateWorkspace(
      stagingRoot,
      async ({ stagingDirectory, publish }) => {
        recoveryDirectory = stagingDirectory;
        await publish(() =>
          publishEventTraceUpdates(
            [
              {
                path: first,
                temporaryPath: join(stagingDirectory, "first.tmp"),
                content: "new first",
              },
              {
                path: second,
                temporaryPath: join(stagingDirectory, "second.tmp"),
                content: "new second",
              },
            ],
            stagingDirectory,
            async (source, destination) => {
              if (destination === second) throw publicationFailure;
              if (source.endsWith("restore-0.tmp")) throw rollbackFailure;
              await rename(source, destination);
            },
          ),
        );
      },
      {
        closeLock: async (lock) => {
          attempts.push("close");
          await lock.close();
          throw closeFailure;
        },
        remove: async (path, options) => {
          attempts.push(String(path));
          await rm(path, options);
          throw removeFailure;
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      const recoveryError: unknown = error.errors[0];
      assert.ok(recoveryError instanceof EventTracePublicationRecoveryError);
      assert.deepEqual(recoveryError.errors, [
        publicationFailure,
        rollbackFailure,
      ]);
      assert.equal(error.cause, recoveryError);
      assert.deepEqual(error.errors, [
        recoveryError,
        closeFailure,
        removeFailure,
      ]);
      return true;
    },
  );
  assert.deepEqual(attempts, ["close", join(stagingRoot, "publish.lock")]);
  assert.equal(
    await readFile(join(recoveryDirectory, "original-0.bak"), "utf8"),
    "original first",
  );
  assert.equal(
    await readFile(join(recoveryDirectory, "original-1.bak"), "utf8"),
    "original second",
  );
  assert.ok((await readdir(recoveryDirectory)).includes("recovery.json"));
});
