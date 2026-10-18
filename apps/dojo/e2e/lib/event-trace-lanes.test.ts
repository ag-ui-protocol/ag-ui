import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { exists, resolveEventTraceLanes } from "./event-trace-lanes";

async function createTests(t: TestContext, files: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "event-trace-lanes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    const path = join(root, "tests", file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "");
  }
  return root;
}

const strandsChat = [
  "awsStrandsTests/chat.spec.ts",
  "awsStrandsTests/chat.event-trace.ts",
  "awsStrandsTypescriptTests/chat.spec.ts",
  "awsStrandsTypescriptTests/chat.event-trace.ts",
];

for (const all of [false, true]) {
  test(`resolves both Strands lanes (all=${all})`, async (t) => {
    const root = await createTests(t, strandsChat);
    const selected = await resolveEventTraceLanes(root, {
      integration: "strands",
      all,
      spec: all ? undefined : "chat",
    });
    assert.deepEqual(
      selected.map(({ lane, targets }) => ({ id: lane.id, targets })),
      [
        {
          id: "strands-typescript",
          targets: [join("tests", "awsStrandsTypescriptTests", "chat.spec.ts")],
        },
        {
          id: "strands-python",
          targets: [join("tests", "awsStrandsTests", "chat.spec.ts")],
        },
      ],
    );
  });
}

for (const counterpart of [[], ["awsStrandsTests/other.spec.ts"]]) {
  test(`rejects a missing Strands counterpart ${counterpart.length ? "spec" : "directory"}`, async (t) => {
    const root = await createTests(t, [
      "awsStrandsTypescriptTests/chat.spec.ts",
      ...counterpart,
    ]);
    await assert.rejects(
      resolveEventTraceLanes(root, {
        integration: "strands",
        all: false,
        spec: "chat",
      }),
      /strands-python.*no matching.*chat/,
    );
  });
}

test("rejects asymmetric instrumented Strands spec coverage before capture", async (t) => {
  const root = await createTests(t, [
    ...strandsChat,
    "awsStrandsTests/weather.spec.ts",
    "awsStrandsTests/weather.event-trace.ts",
  ]);
  await assert.rejects(
    resolveEventTraceLanes(root, { integration: "strands", all: true }),
    /Strands.*same.*specs/,
  );
});

for (const orphanDirectories of [
  ["awsStrandsTypescriptTests", "awsStrandsTests"],
  ["awsStrandsTests"],
]) {
  test(`rejects orphaned companions alongside valid Strands pairs in ${orphanDirectories.join(", ")}`, async (t) => {
    const root = await createTests(t, [
      ...strandsChat,
      ...orphanDirectories.map(
        (directory) => `${directory}/weather.event-trace.ts`,
      ),
    ]);
    await assert.rejects(
      resolveEventTraceLanes(root, { integration: "strands", all: true }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const directory = orphanDirectories.find((directory) =>
          error.message.includes(
            join("tests", directory, "weather.event-trace.ts"),
          ),
        );
        assert.ok(directory, "error must identify the orphaned companion");
        assert.ok(
          error.message.includes(join("tests", directory, "weather.spec.ts")),
        );
        assert.match(error.message, /missing.*spec/i);
        return true;
      },
    );
  });
}

for (const integration of ["strands", "langgraph"] as const) {
  test(`all selects only instrumented specs for ${integration}`, async (t) => {
    const directory =
      integration === "strands" ? "awsStrandsTests" : "langgraphPythonTests";
    const root = await createTests(t, [
      ...(integration === "strands"
        ? strandsChat
        : [`${directory}/chat.spec.ts`, `${directory}/chat.event-trace.ts`]),
      `${directory}/uninstrumented.spec.ts`,
    ]);
    const selected = await resolveEventTraceLanes(root, {
      integration,
      all: true,
    });
    assert.equal(selected.length, integration === "strands" ? 2 : 1);
    for (const { targets } of selected) {
      assert.equal(targets.length, 1);
      assert.ok(targets[0].endsWith("chat.spec.ts"));
    }
  });
}

test("rejects a real orphaned LangGraph baseline", async (t) => {
  const root = await createTests(t, [
    "langgraphPythonTests/chat.spec.ts",
    "langgraphPythonTests/chat.event-trace.ts",
    "langgraphPythonTests/weather.event-trace.ts",
  ]);
  await assert.rejects(
    resolveEventTraceLanes(root, { integration: "langgraph", all: true }),
    /weather\.event-trace\.ts.*missing.*weather\.spec\.ts/,
  );
});

for (const all of [false, true]) {
  test(`keeps absent LangGraph lanes optional (all=${all})`, async (t) => {
    const root = await createTests(t, [
      "langgraphPythonTests/chat.spec.ts",
      "langgraphPythonTests/chat.event-trace.ts",
    ]);
    const selected = await resolveEventTraceLanes(root, {
      integration: "langgraph",
      all,
      spec: all ? undefined : "chat",
    });
    assert.deepEqual(
      selected.map(({ lane }) => lane.id),
      ["python"],
    );
  });
}

test("exists distinguishes present and missing paths", async (t) => {
  const root = await createTests(t, ["present.txt"]);
  assert.equal(await exists(join(root, "tests", "present.txt")), true);
  assert.equal(await exists(join(root, "tests", "missing.txt")), false);
});

test("exists propagates ENOTDIR with the failing path", async (t) => {
  const root = await createTests(t, ["file-parent"]);
  const path = join(root, "tests", "file-parent", "child.txt");
  await assert.rejects(exists(path), { code: "ENOTDIR", path });
});

test("lane discovery cannot silently omit an invalid lane path", async (t) => {
  const root = await createTests(t, [
    "langgraphTypescriptTests",
    "langgraphPythonTests/chat.spec.ts",
  ]);
  await assert.rejects(
    resolveEventTraceLanes(root, {
      integration: "langgraph",
      all: false,
      spec: "chat",
    }),
    {
      code: "ENOTDIR",
      path: join(root, "tests", "langgraphTypescriptTests", "chat.spec.ts"),
    },
  );
});
