// Local and CI entrypoint: node apps/dojo/e2e/scripts/langgraph-parity-ci.mjs v2|v3
// Dependencies must already be installed from the committed lockfiles.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const e2e = path.join(root, "apps/dojo/e2e");
const suites = ["langgraphPythonTests", "langgraphTypescriptTests"];

export function assertGraphConfigParity(base, transformer, language) {
  const expected = Object.keys(base.graphs ?? {}).sort();
  const actual = Object.keys(transformer.graphs ?? {}).sort();
  if (!expected.length)
    throw new Error(`${language}: base config has no graphs`);
  const missing = expected.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) {
    throw new Error(
      `${language}: transformer graph coverage differs from base; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`,
    );
  }
}

export async function validateGraphConfigs(workspace = root) {
  for (const language of ["python", "typescript"]) {
    const directory = path.join(
      workspace,
      "integrations/langgraph",
      language,
      "examples",
    );
    const [base, transformer] = await Promise.all(
      ["langgraph.json", "langgraph.transformer.json"].map(async (name) =>
        JSON.parse(await readFile(path.join(directory, name), "utf8")),
      ),
    );
    assertGraphConfigParity(base, transformer, language);
  }
}

export async function discoverSpecs(directory = e2e) {
  const specs = [];
  for (const suite of suites) {
    for (const name of await readdir(path.join(directory, "tests", suite), {
      recursive: true,
    })) {
      if (!name.endsWith(".spec.ts")) continue;
      const relative = `tests/${suite}/${name}`;
      const source = await readFile(path.join(directory, relative), "utf8");
      if (/from\s+["'][^"']*event-trace[^"']*["']/.test(source))
        specs.push(relative);
    }
  }
  if (!specs.length)
    throw new Error("No instrumented LangGraph Platform specs found");
  return specs.sort();
}

// Existing uninstrumented tests for a button CopilotChat V2 does not render.
// These remain visible in both lane reports and never exempt an event journey.
export const unsupportedUiSkips = new Set([
  "langgraphTypescriptTests/agenticChatDeterministic.spec.ts:[LangGraph] Regenerate produces a new response",
  "langgraphPythonTests/agenticChatPage.spec.ts:[LangGraph] Agentic Chat regenerates a response",
  "langgraphTypescriptTests/agenticChatPage.spec.ts:[LangGraph Typescript] Agentic Chat regenerates a response",
]);

export async function validateUnsupportedUiSkips(listed, directory = e2e) {
  const tests = reportTests(listed);
  for (const { spec, test } of tests) {
    if (
      test.expectedStatus !== "skipped" ||
      !unsupportedUiSkips.has(`${spec.file}:${spec.title}`)
    )
      continue;
    const lines = (
      await readFile(path.join(directory, "tests", spec.file), "utf8")
    ).split("\n");
    const nextLine = Math.min(
      ...tests
        .filter(
          ({ spec: other }) =>
            other.file === spec.file && other.line > spec.line,
        )
        .map(({ spec: other }) => other.line),
      lines.length + 1,
    );
    const body = lines.slice(spec.line - 1, nextLine - 1).join("\n");
    if (/eventTrace|expectJourney/.test(body))
      throw new Error(
        `Unsupported UI skip contains an event journey: ${spec.file}: ${spec.title}`,
      );
  }
}

export function reportTests(report) {
  return (report.suites ?? []).flatMap(function visit(suite) {
    return [
      ...(suite.specs ?? []).flatMap((spec) =>
        spec.tests.map((test) => ({ spec, test })),
      ),
      ...(suite.suites ?? []).flatMap(visit),
    ];
  });
}

export function auditReport(discovered, listed, executed) {
  if (executed.errors?.length)
    throw new Error("Playwright reported global errors");
  const expected = reportTests(listed);
  const actual = reportTests(executed);
  if (!expected.length) throw new Error("Playwright listed no journeys");
  for (const file of discovered) {
    if (!expected.some(({ spec }) => file.endsWith(spec.file))) {
      throw new Error(`Instrumented spec omitted from Playwright: ${file}`);
    }
  }
  const key = ({ spec, test }) => `${spec.id}:${test.projectName}`;
  const actualKeys = new Set(actual.map(key));
  if (
    actual.length !== expected.length ||
    expected.some((item) => !actualKeys.has(key(item)))
  ) {
    throw new Error(
      "Executed journey inventory differs from the discovered inventory",
    );
  }
  for (const { spec, test } of actual) {
    if (
      unsupportedUiSkips.has(`${spec.file}:${spec.title}`) &&
      test.expectedStatus === "skipped" &&
      test.results.length === 1 &&
      test.results[0].status === "skipped"
    )
      continue;
    if (
      test.expectedStatus !== "passed" ||
      test.results.length !== 1 ||
      test.results[0].status !== "passed"
    ) {
      throw new Error(
        `Journey must pass without skips, expected failures, or retries: ${spec.file}: ${spec.title}`,
      );
    }
  }
  return actual.length;
}

async function run(lane) {
  if (!["v2", "v3"].includes(lane))
    throw new Error("Expected lane argument: v2 or v3");
  const output = path.join(e2e, "test-results", `langgraph-parity-${lane}`);
  await mkdir(output, { recursive: true });
  await validateGraphConfigs();
  const specs = await discoverSpecs();
  await writeFile(
    path.join(output, "spec-inventory.json"),
    JSON.stringify(specs, null, 2),
  );
  const env = {
    ...process.env,
    LANGGRAPH_TRACE_REFERENCE: "v2",
    LANGGRAPH_STREAM_PROTOCOL_FOR_TESTS: lane,
    BASE_URL: "http://localhost:19999",
    LANGGRAPH_PYTHON_URL: "http://localhost:18005",
    LANGGRAPH_TYPESCRIPT_URL: "http://localhost:18006",
    AIMOCK_PORT: "15555",
    OPENAI_BASE_URL: "http://localhost:15555/v1",
    OPENAI_API_BASE: "http://localhost:15555/v1",
    OPENAI_API_KEY: "parity-mock-key",
    AG_UI_MOCK_WEATHER: "1",
    LANGSMITH_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    PYTHONPATH: [
      "integrations/langgraph/python",
      "sdks/python",
      "integrations/langgraph/python/examples",
    ]
      .map((p) => path.join(root, p))
      .join(path.delimiter),
  };
  // Do not inherit reporting credentials or reference-regeneration modes from a local shell.
  for (const name of [
    "LANGGRAPH_EVENT_SOURCE_FOR_TESTS",
    "SLACK_WEBHOOK_URL",
    "AWS_S3_BUCKET_NAME",
    "LANGSMITH_API_KEY",
    "LANGCHAIN_API_KEY",
    "UPDATE_EVENT_TRACES",
    "EVENT_TRACE_UPDATE_STAGING_DIR",
    "EVENT_TRACE_UPDATE_LANE",
  ])
    delete env[name];
  if (lane === "v3") env.LANGGRAPH_EVENT_SOURCE_FOR_TESTS = "transformer";
  const children = [];
  const logs = [];
  function start(name, command, args, cwd = root, extraEnv = {}) {
    const log = createWriteStream(path.join(output, `${name}.log`));
    logs.push(log);
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.failure = undefined;
    child.on("error", (error) => {
      child.failure = error;
    });
    children.push(child);
    return child;
  }
  async function finish(child) {
    if (child.failure) throw child.failure;
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0)
      throw new Error(
        `Process ${child.spawnargs.join(" ")} exited ${code}; see ${output}`,
      );
  }
  async function health(url, child) {
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (child.failure || child.exitCode !== null)
        throw (
          child.failure ?? new Error(`Server exited before ${url} was ready`)
        );
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) return;
      } catch {
        /* Health probe retries only until the bounded startup deadline. */
      }
      await delay(500);
    }
    throw new Error(`Timed out waiting for ${url}; see ${output}`);
  }
  function signalChildren(signal) {
    for (const child of children) {
      if (!child.pid) continue;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  const onSignal = () => {
    signalChildren("SIGTERM");
    process.exitCode = 1;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    // Never accidentally test an unrelated local server already occupying these ports.
    for (const port of [18005, 18006, 19999, 15555]) {
      await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, () => server.close(resolve));
      });
    }
    const config =
      lane === "v3" ? "langgraph.transformer.json" : "langgraph.json";
    const python = start(
      "python",
      "uv",
      [
        "run",
        "--frozen",
        "python",
        "-m",
        "langgraph_api.cli",
        "--config",
        config,
        "--no-reload",
        "--host",
        "127.0.0.1",
        "--port",
        "18005",
      ],
      path.join(root, "integrations/langgraph/python/examples"),
    );
    const typescript = start(
      "typescript",
      "pnpm",
      [
        "exec",
        "langgraphjs",
        "dev",
        "--config",
        config,
        "--no-browser",
        "--host",
        "127.0.0.1",
        "--port",
        "18006",
      ],
      path.join(root, "integrations/langgraph/typescript/examples"),
    );
    const dojo = start("dojo", "pnpm", [
      "--dir",
      "apps/dojo",
      "exec",
      "next",
      "dev",
      "--port",
      "19999",
    ]);
    await Promise.all([
      health("http://localhost:18005/ok", python),
      health("http://localhost:18006/ok", typescript),
      health(env.BASE_URL, dojo),
    ]);
    const listedFile = path.join(output, "listed.json");
    const executedFile = path.join(output, "executed.json");
    await finish(
      start(
        "list",
        "pnpm",
        ["exec", "playwright", "test", ...specs, "--list", "--reporter=json"],
        e2e,
        { PLAYWRIGHT_JSON_OUTPUT_FILE: listedFile },
      ),
    );
    const listed = JSON.parse(await readFile(listedFile, "utf8"));
    await validateUnsupportedUiSkips(listed);
    await finish(
      start(
        "playwright",
        "pnpm",
        [
          "exec",
          "playwright",
          "test",
          ...specs,
          "--workers=1",
          "--retries=0",
          "--forbid-only",
          "--trace=retain-on-failure",
          "--reporter=line,json",
          `--output=${path.join(output, "browser")}`,
        ],
        e2e,
        { PLAYWRIGHT_JSON_OUTPUT_FILE: executedFile },
      ),
    );
    const count = auditReport(
      specs,
      listed,
      JSON.parse(await readFile(executedFile, "utf8")),
    );
    const skipped = reportTests(listed).filter(
      ({ test }) => test.expectedStatus === "skipped",
    ).length;
    console.log(
      `${lane}: ${specs.length} instrumented specs / ${count} total tests / ${count - skipped} passed / ${skipped} existing unsupported regeneration UI skips; all event journeys use V2 references`,
    );
  } finally {
    signalChildren("SIGTERM");
    await delay(1000);
    signalChildren("SIGKILL");
    for (const log of logs) log.end();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
