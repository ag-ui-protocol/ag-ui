import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("HTTP stream failure isolation", () => {
  it("survives a terminated SSE stream and completes another run in the same process", () => {
    // Nx builds the package before tests. Exercise its published entry in a
    // child: Vitest's unhandled-rejection listener would mask process death.
    const entry = new URL("../../../dist/index.mjs", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import http from "node:http";
      import { setImmediate } from "node:timers/promises";
      import { HttpAgent } from ${JSON.stringify(entry)};

      let failingResponse;
      let requests = 0;
      const server = http.createServer((req, res) => {
        req.resume();
        const runId = ++requests === 1 ? "failure" : "healthy";
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({
          type: "RUN_STARTED", threadId: "thread", runId,
        }) + "\\n\\n");
        if (runId === "failure") {
          failingResponse = res;
        } else {
          res.end("data: " + JSON.stringify({
            type: "RUN_FINISHED", threadId: "thread", runId,
          }) + "\\n\\n");
        }
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const agent = new HttpAgent({
          url: "http://127.0.0.1:" + server.address().port,
          threadId: "thread",
        });
        await assert.rejects(agent.runAgent({ runId: "failure" }, {
          onRunStartedEvent: () => failingResponse.destroy(),
        }), error => error instanceof TypeError && error.cause?.code === "UND_ERR_SOCKET");
        assert.equal(agent.isRunning, false);
        // Give detached cleanup rejections a turn to terminate Node, without
        // installing any handler that would suppress that failure.
        await setImmediate();
        let finished = false;
        await agent.runAgent({ runId: "healthy" }, {
          onRunFinishedEvent: () => { finished = true; },
        });
        assert.equal(finished, true);
        assert.equal(requests, 2);
        assert.equal(agent.isRunning, false);
        await setImmediate();
        console.log("healthy run completed");
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--unhandled-rejections=strict", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("healthy run completed");
  });
});
