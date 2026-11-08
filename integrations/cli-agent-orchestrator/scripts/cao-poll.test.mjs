import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { caoStatus, pollUntil } from "./cao-poll.mjs";

// Accepts the request and never answers.
function silentServer() {
  const server = createServer(() => {});
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      }),
    ),
  );
}

test("caoStatus fails fast against a server that never answers", async (t) => {
  const s = await silentServer();
  t.after(() => s.close());
  const started = Date.now();
  await assert.rejects(caoStatus(s.url, "x", 300));
  assert.ok(Date.now() - started < 2000);
});

test("pollUntil stops at its wall-clock deadline even if every probe hangs on a silent server", async (t) => {
  const s = await silentServer();
  t.after(() => s.close());
  const started = Date.now();
  const ok = await pollUntil(
    async () => (await caoStatus(s.url, "x", 200)) === "idle",
    1000,
    50,
  );
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 2500);
});

test("pollUntil returns true as soon as the probe passes", async () => {
  let n = 0;
  assert.equal(await pollUntil(() => ++n === 3, 5000, 10), true);
});

test("pollUntil retries a probe that throws synchronously", async () => {
  let n = 0;
  const probe = () => {
    if (++n < 3) throw new Error("sync");
    return true;
  };
  assert.equal(await pollUntil(probe, 5000, 10), true);
});

test("pollUntil returns false at the deadline for a probe that never settles", async () => {
  const t0 = Date.now();
  assert.equal(await pollUntil(() => new Promise(() => {}), 300, 10), false);
  assert.ok(Date.now() - t0 < 1500);
});

test("pollUntil does not count a probe that resolves true after the deadline", async () => {
  const probe = () => new Promise((r) => setTimeout(() => r(true), 400));
  assert.equal(await pollUntil(probe, 200, 10), false);
});
