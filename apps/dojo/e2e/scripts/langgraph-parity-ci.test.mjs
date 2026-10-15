import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertGraphConfigParity,
  validateGraphConfigs,
  auditReport,
  discoverSpecs,
  validateUnsupportedUiSkips,
} from "./langgraph-parity-ci.mjs";

function report(status = "passed", expectedStatus = "passed") {
  return {
    suites: [
      {
        suites: [
          {
            specs: [
              {
                id: "one",
                file: "langgraphPythonTests/example.spec.ts",
                title: "journey",
                tests: [
                  {
                    projectName: "chromium",
                    expectedStatus,
                    results: [{ status }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
const files = ["tests/langgraphPythonTests/example.spec.ts"];
test("audit rejects omitted files, journeys, skipped tests, and expected failures", () => {
  assert.equal(auditReport(files, report(), report()), 1);
  assert.throws(
    () => auditReport([...files, "missing.spec.ts"], report(), report()),
    /omitted/,
  );
  assert.throws(
    () => auditReport(files, report(), { suites: [] }),
    /inventory/,
  );
  assert.throws(
    () => auditReport(files, report(), report("skipped")),
    /without skips/,
  );
  assert.throws(
    () => auditReport(files, report(), report("failed", "failed")),
    /without skips/,
  );
  assert.throws(
    () => auditReport(files, report(), { ...report(), errors: [{}] }),
    /global errors/,
  );
});
test("discover every instrumented Platform spec, excluding FastAPI", async () => {
  const specs = await discoverSpecs();
  assert.ok(
    specs.length >= 29,
    `Expected at least the 29 current specs, found ${specs.length}`,
  );
  assert.ok(specs.some((file) => file.includes("langgraphPythonTests")));
  assert.ok(specs.some((file) => file.includes("langgraphTypescriptTests")));
  assert.ok(specs.every((file) => !file.includes("FastAPI")));
});

test("unsupported UI exception is restricted to exact pre-existing titles", () => {
  const listed = report("skipped", "skipped");
  listed.suites[0].suites[0].specs[0].file =
    "langgraphPythonTests/agenticChatPage.spec.ts";
  listed.suites[0].suites[0].specs[0].title =
    "[LangGraph] Agentic Chat regenerates a response";
  const executed = structuredClone(listed);
  const discovered = ["tests/langgraphPythonTests/agenticChatPage.spec.ts"];
  assert.equal(auditReport(discovered, listed, executed), 1);
  executed.suites[0].suites[0].specs[0].title += " new journey";
  assert.throws(
    () => auditReport(discovered, listed, executed),
    /without skips/,
  );
});

test("unsupported UI exception cannot hide an instrumented journey", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "parity-audit-"));
  try {
    await mkdir(path.join(directory, "tests/langgraphPythonTests"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        directory,
        "tests/langgraphPythonTests/agenticChatPage.spec.ts",
      ),
      'test.skip("[LangGraph] Agentic Chat regenerates a response", async ({ eventTrace }) => { await eventTrace.expectJourney(trace); });',
    );
    const listed = report("skipped", "skipped");
    Object.assign(listed.suites[0].suites[0].specs[0], {
      file: "langgraphPythonTests/agenticChatPage.spec.ts",
      title: "[LangGraph] Agentic Chat regenerates a response",
      line: 1,
    });
    await assert.rejects(
      validateUnsupportedUiSkips(listed, directory),
      /contains an event journey/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transformer configs cover every base graph, including newly added graphs", async () => {
  await validateGraphConfigs();
  const base = { graphs: { chat: "./chat", newlyAdded: "./new" } };
  assert.throws(
    () =>
      assertGraphConfigParity(
        base,
        { graphs: { chat: "./wrapped" } },
        "python",
      ),
    /missing: newlyAdded/,
  );
  assert.throws(
    () =>
      assertGraphConfigParity(
        { graphs: { chat: "./chat" } },
        { graphs: { chat: "./wrapped", stale: "./old" } },
        "typescript",
      ),
    /extra: stale/,
  );
  assert.throws(() => assertGraphConfigParity({}, {}, "python"), /no graphs/);
  assert.doesNotThrow(() =>
    assertGraphConfigParity(
      base,
      { graphs: { newlyAdded: "./wrapped-new", chat: "./wrapped" } },
      "python",
    ),
  );
});
