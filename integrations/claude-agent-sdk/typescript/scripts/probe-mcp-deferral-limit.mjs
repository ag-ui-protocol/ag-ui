// Reproduces the known in-process MCP startup limitation. Local fake provider only.
import http from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  query,
  createSdkMcpServer,
  tool,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
const dir = await mkdtemp(join(tmpdir(), "pni659-native-"));
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
        name: "mcp__native__approval",
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
      : { type: "input_json_delta", partial_json: '{"value":"test"}' },
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
let executed = 0;
const makeMcp = () =>
  createSdkMcpServer({
    name: "native",
    tools: [
      tool(
        "approval",
        "Synthetic approval test",
        { value: z.string() },
        async () => {
          executed++;
          return { content: [{ type: "text", text: "REAL_SYNTHETIC_RESULT" }] };
        },
      ),
    ],
  });
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
let session;
try {
  for (const decision of ["defer", "allow"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      for await (const message of query({
        prompt: session
          ? (async function* () {
              await gate;
            })()
          : "Synthetic tool test",
        options: {
          extraArgs: { "await-initialize": null },
          env,
          cwd: dir,
          settingSources: [],
          model: "claude-sonnet-4-6",
          tools: [],
          mcpServers: { native: makeMcp() },
          resume: session,
          abortController: controller,
          maxTurns: 3,
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input) => ({
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: decision,
                    },
                  }),
                ],
              },
            ],
          },
        },
      })) {
        if (message.type === "system" && message.subtype === "init") {
          session = message.session_id;
          console.log(
            JSON.stringify({
              initTools: message.tools,
              mcp: message.mcp_servers,
            }),
          );
        }
        if (message.type === "result") release();
        if (message.type === "result")
          console.log(
            JSON.stringify({
              decision,
              session: message.session_id,
              reason: message.stop_reason,
              error: message.is_error,
              deferred: message.deferred_tool_use,
              executed,
            }),
          );
        if (message.type === "result" && message.is_error) break;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(JSON.stringify({ dir, calls, executed, session }));
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  server.close();
}
