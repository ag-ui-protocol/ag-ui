import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HttpAgent } from "@ag-ui/client";

const workspace = fileURLToPath(new URL("../", import.meta.url));

test("the published TypeScript client consumes two Rust-hosted runs", async (t) => {
  const build = execFileSync("cargo", [
    "build", "--locked", "-p", "ag-ui-migration-tests", "--example", "local_round_trip",
    "--message-format=json",
  ], { cwd: workspace, encoding: "utf8" });
  const binary = build.trim().split("\n").map(JSON.parse)
    .find((entry) => entry.target?.name === "local_round_trip" && entry.executable)?.executable;
  assert.ok(binary, "Cargo reported the example executable");

  const server = spawn(binary, ["--serve"], { stdio: ["ignore", "pipe", "inherit"] });
  const exit = once(server, "close");
  t.after(async () => {
    server.kill();
    await exit;
  });
  const lines = createInterface({ input: server.stdout });
  const ready = once(lines, "line", { signal: AbortSignal.timeout(10_000) });
  const [url] = await Promise.race([ready, exit.then(() => { throw Error("server exited before listening"); })]);
  lines.close();
  const threadId = "typescript-rust-interop";
  const agent = new HttpAgent({ url, threadId });
  for (const turn of [1, 2]) {
    const runId = `turn-${turn}`;
    agent.addMessage({ id: `question-${turn}`, role: "user", content: "hello" });
    const observed = [];
    const abortController = new AbortController();
    const deadline = setTimeout(() => abortController.abort(), 10_000);
    try {
      const result = await agent.runAgent({ runId, abortController }, {
        onRunStartedEvent: ({ event }) => observed.push([event.type, event.threadId, event.runId, event.protocolVersion]),
        onRunFinishedEvent: ({ event }) => observed.push([event.type, event.threadId, event.runId]),
      });
      assert.deepEqual(observed, [
        ["RUN_STARTED", threadId, runId, "1.0"],
        ["RUN_FINISHED", threadId, runId],
      ]);
      assert.deepEqual(result.newMessages.map(({ role, content }) => [role, content]), [
        ["assistant", `Received ${2 * turn - 1} messages.`],
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }
  assert.equal(agent.messages.length, 4);
});
