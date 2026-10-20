import assert from "node:assert/strict";
import test from "node:test";
import { ensureSseUtf8 } from "../../src/lib/ensure-sse-utf8";

const unicodePayload = 'data: {"delta":"🍝 sauté 勝利"}\n\n';

test("declares UTF-8 without consuming or replacing the live SSE stream", async () => {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const original = new Response(stream.readable, {
    status: 202,
    statusText: "Accepted",
    headers: {
      "content-type": "text/event-stream",
      "x-custom": "preserved",
      "cache-control": "no-cache",
    },
  });
  const response = ensureSseUtf8(original);
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(response.body, original.body);
  assert.equal(response.bodyUsed, false);
  assert.equal(response.status, 202);
  assert.equal(response.statusText, "Accepted");
  assert.equal(response.headers.get("x-custom"), "preserved");
  assert.equal(response.headers.get("cache-control"), "no-cache");
  const body = response.text();
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(unicodePayload));
  await writer.close();
  assert.equal(await body, unicodePayload);
});
