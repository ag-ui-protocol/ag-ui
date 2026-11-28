// The tested implementation is the official, pinned TypeScript HttpAgent.
// This file supplies only lifecycle inputs, assertions, and process ownership.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const token = "interop-only-not-a-secret";

async function worker(configFile, resultFile) {
  const { HttpAgent } = await import("../../../../typescript/packages/client/dist/index.mjs");
  const { url, input } = JSON.parse(await readFile(configFile, "utf8"));
  const client = new HttpAgent({
    url, threadId: input.threadId, initialMessages: input.messages,
    initialState: input.state, headers: { Authorization: `Bearer ${token}` },
  });
  // Restoration uses the public state property. Constructor null defaults to {},
  // but restoring a prior canonical null must still exercise terminal wire omission.
  client.state = input.state;
  const events = [];
  const warnings = [];
  const callbacks = { initialized: 0, finalized: 0, failed: 0 };
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  try {
    const result = await client.runAgent({
      runId: input.runId, tools: input.tools, context: input.context,
      forwardedProps: input.forwardedProps, resume: input.resume,
    }, {
      onRunInitialized({ input: outgoing }) {
        callbacks.initialized++;
        // parentRunId is not in TS RunAgentParameters. The official public
        // subscriber seam preserves it on the complete input before transmission.
        if (input.parentRunId !== undefined) outgoing.parentRunId = input.parentRunId;
      },
      onRunFinalized() { callbacks.finalized++; },
      onRunFailed({ error }) { callbacks.failed++; throw error; },
      onEvent({ event }) { events.push(structuredClone(event)); },
    });
    assert.deepEqual(callbacks, { initialized: 1, finalized: 1, failed: 0 });
    await writeFile(resultFile, JSON.stringify({
      messages: client.messages, state: client.state, events, callbacks, warnings,
      result: result.result, pendingInterrupts: client.pendingInterrupts,
    }, null, 2));
  } finally { console.warn = originalWarn; }
}

async function startHost(binary, scenario, step, trace) {
  const child = spawn(binary, [scenario, String(step), trace], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part) => { stderr += part; });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Register rejection handling immediately, before a failed readiness handshake.
  exit.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  let timer;
  const url = await Promise.race([
    (async () => { for await (const line of lines) { return line; } throw new Error("host exited before readiness"); })(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("host readiness timeout")), 10000); }),
  ]).finally(() => { clearTimeout(timer); lines.close(); }).catch(async (error) => {
    child.kill(); await exit; throw new Error(`${error.message}\n${stderr}`);
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/agent$/);
  return { child, url, exit, stderr: () => stderr };
}

async function controller(binary, output) {
  const scenarios = JSON.parse(await readFile(path.join(here, "scenarios.json"), "utf8"));
  const temporary = await mkdtemp(path.join(tmpdir(), "ag-ui-ts-interop-"));
  const evidence = [];
  try {
    for (const [name, steps] of Object.entries(scenarios)) {
      let previous;
      for (const [index, step] of steps.entries()) {
        const input = structuredClone(step.input);
        if (step.carryHistory) {
          assert.ok(previous, "second-turn history must come from the preceding public result");
          input.messages = [...previous.messages, ...step.appendMessages];
          input.state = previous.state;
        }
        const tracePath = path.join(temporary, `${name}-${index}-trace.json`);
        const configPath = path.join(temporary, `${name}-${index}-input.json`);
        const resultPath = path.join(temporary, `${name}-${index}-result.json`);
        const host = await startHost(binary, name, index, tracePath);
        try {
          await writeFile(configPath, JSON.stringify({ url: host.url, input }));
          // A new OS process for each client turn proves application state can be
          // restored without a surviving client object or a harness-only subscriber.
          await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), "--worker", configPath, resultPath], { timeout: 20000 });
          const status = await host.exit;
          assert.equal(status.code, 0, `${name}/${index}: ${host.stderr()}`);
          const trace = JSON.parse(await readFile(tracePath, "utf8"));
          const observed = JSON.parse(await readFile(resultPath, "utf8"));
          assert.deepEqual(observed.messages, step.expectedMessages, `${name}/${index} complete history`);
          assert.deepEqual(observed.state, step.expectedState, `${name}/${index} state`);
          const terminal = step.response.at(-1);
          assert.deepEqual(observed.pendingInterrupts, terminal.outcome?.type === "interrupt" ? terminal.outcome.interrupts : [], `${name}/${index} pending interrupts`);
          assert.deepEqual(observed.result, terminal.result, `${name}/${index} result`);
          assert.deepEqual(trace.request, step.expectedRequest, `${name}/${index} exact wire request`);
          assert.deepEqual(observed.events, trace.responseEvents, `${name}/${index} delivered payloads`);
          assert.deepEqual(observed.warnings, [], `${name}/${index} unexpected TS diagnostics`);
          assert.deepEqual(trace.diagnostics, [], `${name}/${index} unexpected producer diagnostics`);
          assert.equal(trace.responseEvents[0].protocolVersion, "1.0");
          evidence.push({ scenario: name, step: index, trace, ...observed });
          previous = { messages: observed.messages, state: observed.state };
        } finally {
          if (host.child.exitCode === null) host.child.kill();
          await host.exit;
        }
      }
    }
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ client: "TypeScript official HttpAgent 1.0.1", exchanges: evidence.length, evidence }, null, 2));
    console.log(`TypeScript interoperability: ${evidence.length} real HTTP exchanges passed`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[2] === "--worker") {
  await worker(process.argv[3], process.argv[4]);
} else {
  const binary = process.argv[2];
  const output = process.argv[3];
  assert.ok(binary && output, "usage: node fixture-client.mjs FIXTURE_HOST_BINARY EVIDENCE.json");
  await controller(path.resolve(binary), path.resolve(output));
}
