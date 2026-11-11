import {
  copyFile,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "../../../..");
const directory = await mkdtemp(join(tmpdir(), "ag-ui-codex-packed-"));
let server;
try {
  const tarballs = join(directory, "tarballs");
  await mkdir(tarballs);
  const projects = [
    "sdks/typescript/packages/core",
    "sdks/typescript/packages/proto",
    "sdks/typescript/packages/encoder",
    "sdks/typescript/packages/client",
    "integrations/community/codex-sdk/typescript",
  ];
  const archives = [];
  for (const project of projects) {
    const projectPath = join(repository, project);
    execFileSync("pnpm", ["pack", "--pack-destination", tarballs], {
      cwd: projectPath,
      stdio: "pipe",
    });
    const manifest = JSON.parse(
      await readFile(join(projectPath, "package.json"), "utf8"),
    );
    archives.push(
      join(
        tarballs,
        `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`,
      ),
    );
  }
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...archives,
      "zod@3.25.76",
    ],
    { cwd: consumer, stdio: "pipe", timeout: 120000 },
  );
  const fixture = join(directory, "codex-exec.mjs");
  await copyFile(join(root, "examples/testing/codex-exec.mjs"), fixture);
  await chmod(fixture, 0o755);
  const env = {
    ...process.env,
    CODEX_TEST_MODE: "1",
    CODEX_FIXTURE_DIR: join(directory, "fixture"),
    CODEX_PATH: fixture,
    HOST: "127.0.0.1",
    PORT: "0",
  };
  const run = `
const agent = new CodexAgentAdapter({codexOptions:{codexPathOverride:process.env.CODEX_PATH}});
agent.addMessage({id:'user',role:'user',content:'My name is Alice'});
await agent.runAgent();
if(!agent.messages.some(m=>m.role==='assistant' && m.content.includes('Alice'))) throw Error('Packed adapter did not run');
`;
  await writeFile(
    join(consumer, "esm.mjs"),
    `import { CodexAgentAdapter } from '@ag-ui/codex-sdk';\n${run}`,
  );
  await writeFile(
    join(consumer, "commonjs.cjs"),
    `const { CodexAgentAdapter } = require('@ag-ui/codex-sdk');\n(async()=>{${run}})().catch(e=>{console.error(e);process.exitCode=1;});`,
  );
  for (const script of ["esm.mjs", "commonjs.cjs"])
    execFileSync(process.execPath, [script], {
      cwd: consumer,
      env,
      stdio: "pipe",
      timeout: 15000,
    });
  server = spawn(
    process.execPath,
    ["node_modules/@ag-ui/codex-sdk/dist/examples/server.js"],
    { cwd: consumer, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  server.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const port = await new Promise((resolvePort, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Installed server startup timed out: ${errors}`)),
      15000,
    );
    server.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Installed server exited: ${errors}`));
    });
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/listening on (\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolvePort(Number(match[1]));
      }
    });
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  const response = await fetch(`http://127.0.0.1:${port}/agentic_chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: "packed-http",
      runId: "run",
      messages: [{ id: "u", role: "user", content: "Hello" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  const events = await response.text();
  assert.match(events, /RUN_FINISHED/);
  assert.doesNotMatch(events, /RUN_ERROR/);
  process.stdout.write(
    "Packed ESM and CommonJS adapters and installed standalone server passed.\n",
  );
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  await rm(directory, { recursive: true, force: true });
}
