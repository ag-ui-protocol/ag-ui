// Exercise actual SDK record splitting against a synthetic localhost provider.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { lastValueFrom, toArray } from "rxjs";
import { createRequire } from "node:module";
const { ClaudeAgentAdapter } = createRequire(import.meta.url)(
  "../src/adapter.ts",
);
const dir = await mkdtemp(join(tmpdir(), "claude-blocks-"));
let toolCase = false;
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url.includes("count_tokens")) {
    res.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  if (!req.url.includes("/messages")) {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  const body = JSON.parse(raw);
  const answered = body.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_result"),
  );
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: answered ? "msg_done" : "msg_blocks",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  const blocks = answered
    ? [{ type: "text", text: "Done" }]
    : [
        { type: "text", text: "First." },
        toolCase
          ? {
              type: "tool_use",
              id: "toolu_fixture",
              name: "Read",
              input: { file_path: join(dir, "missing.txt") },
            }
          : { type: "text", text: "Second." },
      ];
  blocks.forEach((block, index) => {
    send("content_block_start", {
      index,
      content_block:
        block.type === "text"
          ? { type: "text", text: "" }
          : { ...block, input: {} },
    });
    send("content_block_delta", {
      index,
      delta:
        block.type === "text"
          ? { type: "text_delta", text: block.text }
          : {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
    });
    send("content_block_stop", { index });
  });
  send("message_delta", {
    delta: {
      stop_reason: toolCase && !answered ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 10 },
  });
  send("message_stop", {});
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  PATH: process.env.PATH,
  HOME: dir,
  CLAUDE_CONFIG_DIR: join(dir, "config"),
  ANTHROPIC_API_KEY: "synthetic",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
};
try {
  for (const partial of [false, true])
    for (const hasTool of [false, true]) {
      toolCase = hasTool;
      const adapter = new ClaudeAgentAdapter({
        env,
        cwd: dir,
        settingSources: [],
        model: "claude-sonnet-4-6",
        tools: ["Read"],
        allowedTools: ["Read"],
        maxTurns: 2,
        includePartialMessages: partial,
        queryTimeoutMs: 20000,
      });
      const events = await lastValueFrom(
        adapter
          .run({
            threadId: `blocks-${partial}-${hasTool}`,
            runId: "run",
            messages: [{ id: "user", role: "user", content: "Synthetic test" }],
            tools: [],
            context: [],
            state: null,
            forwardedProps: {},
          })
          .pipe(toArray()),
      );
      assert.equal(
        events.at(-1).type,
        "RUN_FINISHED",
        JSON.stringify(events.at(-1)),
      );
      const messages = events.find(
        (event) => event.type === "MESSAGES_SNAPSHOT",
      ).messages;
      const assistant = messages.find((message) => message.id === "msg_blocks");
      assert.equal(assistant.content, hasTool ? "First." : "First.Second.");
      if (hasTool) assert.equal(assistant.toolCalls[0].id, "toolu_fixture");
      assert.equal(
        messages.filter((message) => message.id === "msg_blocks").length,
        1,
      );
      console.log(JSON.stringify({ partial, hasTool, passed: true }));
    }
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
