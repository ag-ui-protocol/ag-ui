// Localhost fake-provider probe: only synthetic files, no real model calls.
import http from "node:http";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { lastValueFrom, toArray } from "rxjs";
import { createRequire } from "node:module";
const { ClaudeAgentAdapter } = createRequire(import.meta.url)(
  "../src/adapter.ts",
);
const dir = await mkdtemp(join(tmpdir(), "pni659-native-"));
await writeFile(join(dir, "fixture.txt"), "REAL_SYNTHETIC_RESULT");
let calls = 0;
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  if (req.url.includes("count_tokens")) {
    res.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  if (!req.url.includes("/messages")) {
    res.statusCode = 404;
    res.end("{}");
    return;
  }
  const body = JSON.parse(raw);
  calls++;
  console.log(JSON.stringify({ tools: body.tools?.map((t) => t.name) }));
  const answered = JSON.stringify(body.messages).includes("tool_result");
  const block = answered
    ? { type: "text", text: "" }
    : {
        type: "tool_use",
        id: "toolu_synthetic_original",
        name: "Read",
        input: {},
      };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: `msg_synthetic_${calls}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: block });
  send("content_block_delta", {
    index: 0,
    delta: answered
      ? { type: "text_delta", text: "Synthetic completion" }
      : {
          type: "input_json_delta",
          partial_json: JSON.stringify({ file_path: join(dir, "fixture.txt") }),
        },
  });
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: {
      stop_reason: answered ? "end_turn" : "tool_use",
      stop_sequence: null,
    },
    usage: { output_tokens: 10 },
  });
  send("message_stop", {});
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const env = {
  PATH: process.env.PATH,
  HOME: dir,
  CLAUDE_CONFIG_DIR: join(dir, "config"),
  ANTHROPIC_API_KEY: "synthetic-not-a-secret",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
};
process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
let saved;
const store = {
  load: async () => structuredClone(saved),
  save: async (_thread, binding) => {
    saved = structuredClone(binding);
  },
};
const config = {
  queryTimeoutMs: 20000,
  sessionRecovery: {
    store,
    profile: "original",
    deferTools: ["Read"],
    resolveProfile: async () => ({
      env,
      cwd: dir,
      settingSources: [],
      model: "claude-sonnet-4-6",
      tools: ["Read"],
      maxTurns: 3,
    }),
  },
};
const input = {
  threadId: "synthetic",
  runId: "first",
  messages: [{ id: "user", role: "user", content: "Synthetic read" }],
  tools: [],
  context: [],
  state: null,
  forwardedProps: {},
};
const answer = process.argv.includes("--allow") ? "allow" : "deny";
try {
  const first = await lastValueFrom(
    new ClaudeAgentAdapter(config).run(input).pipe(toArray()),
  );
  assert.equal(first.at(-1).type, "RUN_FINISHED", JSON.stringify(first.at(-1)));
  const session = saved.sessionId,
    pending = structuredClone(saved.pending);
  const second = await lastValueFrom(
    new ClaudeAgentAdapter(config)
      .run({
        ...input,
        runId: "second",
        messages: [],
        resume: [
          {
            interruptId: pending.id,
            status: "resolved",
            payload: { behavior: answer },
          },
        ],
      })
      .pipe(toArray()),
  );
  assert.equal(
    second.at(-1).type,
    "RUN_FINISHED",
    JSON.stringify(second.at(-1)),
  );
  assert.equal(saved.sessionId, session);
  assert.equal(saved.pending, undefined);
  const projects = join(dir, "config", "projects");
  const project = (await readdir(projects))[0];
  const rows = (
    await readFile(join(projects, project, session + ".jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  const results = rows
    .flatMap((r) => r.message?.content ?? [])
    .filter((b) => b.type === "tool_result" && b.tool_use_id === pending.id);
  assert.equal(results.length, 1);
  const emitted = second.filter(
    (e) => e.type === "TOOL_CALL_RESULT" && e.toolCallId === pending.id,
  );
  assert.equal(emitted.length, 1);
  if (results[0].is_error) {
    assert.deepEqual(JSON.parse(emitted[0].content), {
      error: true,
      content: results[0].content,
    });
    assert.equal(emitted[0].rawEvent.is_error, true);
  } else assert.deepEqual(emitted[0].content, results[0].content);
  assert.equal(results[0].is_error === true, answer === "deny");
  if (answer === "allow")
    assert.match(results[0].content, /REAL_SYNTHETIC_RESULT/);
  assert.equal(
    calls,
    2,
    "One initial model turn and one resumed completion; no extra empty user turn",
  );
  console.log(
    JSON.stringify({ answer, session, call: pending.id, results, calls }),
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  server.close();
}
