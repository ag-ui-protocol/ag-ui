import assert from "node:assert/strict";
import test from "node:test";
import { ensureSseUtf8 } from "../../src/lib/ensure-sse-utf8";

test("declares SSE responses as UTF-8 without changing their payload", async () => {
  const response = new Response('data: {"text":"שלום 👋"}\n\n', {
    status: 201,
    statusText: "Streaming",
    headers: {
      "content-type": "text/event-stream",
      "x-event-trace-test": "preserved",
    },
  });

  const encoded = ensureSseUtf8(response);

  assert.equal(encoded.status, 201);
  assert.equal(encoded.statusText, "Streaming");
  assert.equal(
    encoded.headers.get("content-type"),
    "text/event-stream; charset=utf-8",
  );
  assert.equal(encoded.headers.get("x-event-trace-test"), "preserved");
  assert.equal(await encoded.text(), 'data: {"text":"שלום 👋"}\n\n');
});

test("leaves non-SSE responses unchanged", () => {
  const response = Response.json({ ok: true });

  assert.equal(ensureSseUtf8(response), response);
});
