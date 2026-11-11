#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

if (process.env.CODEX_TEST_MODE !== "1" || !process.env.CODEX_FIXTURE_DIR) {
  process.stderr.write(
    "Controlled executable requires explicit test mode and fixture directory.\n",
  );
  process.exit(2);
}
const directory = process.env.CODEX_FIXTURE_DIR;
await mkdir(directory, { recursive: true });
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("resume");
const id = resumeIndex < 0 ? randomUUID() : args[resumeIndex + 1];
if (!/^[a-zA-Z0-9-]+$/.test(id ?? "")) process.exit(2);
const recordPath = join(directory, `${id}.json`);
const record =
  resumeIndex < 0
    ? { prompts: [], name: null }
    : JSON.parse(await readFile(recordPath, "utf8"));
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
record.prompts.push(prompt);
const match = prompt.match(/(?:my name is|call me)\s+([a-zA-Z]+)/i);
if (match) record.name = match[1];
await writeFile(recordPath, JSON.stringify(record));
await writeFile(
  join(directory, "invocation.json"),
  JSON.stringify({ args, prompt, pid: process.pid, id }),
);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: id });
emit({ type: "turn.started" });
if (prompt.includes("[fixture:hang]")) {
  await new Promise(() => setInterval(() => {}, 1000));
}
if (prompt.includes("[fixture:malformed]")) {
  process.stdout.write("invalid JSON containing private fixture detail\n");
  process.exit(0);
}
if (prompt.includes("[fixture:error]") || prompt.includes("codex-test-error")) {
  emit({
    type: "turn.failed",
    error: { message: "private fixture failure detail" },
  });
  process.exit(0);
}
const text =
  /(?:what.*my name|remember.*name)/i.test(prompt) && !match
    ? record.name
      ? `Your name is ${record.name}.`
      : "I do not know your name."
    : match
      ? `Hello ${record.name}. I will remember your name.`
      : "Hello! How can I help you?";
if (prompt.includes("[fixture:interleaved]")) {
  emit({
    type: "item.started",
    item: { id: "first", type: "agent_message", text: "First" },
  });
  emit({
    type: "item.completed",
    item: { id: "second", type: "agent_message", text: "Second reply." },
  });
  emit({
    type: "item.completed",
    item: { id: "first", type: "agent_message", text: "First reply." },
  });
} else {
  const item = { id: "reply", type: "agent_message", text };
  emit({ type: "item.started", item: { ...item, text: "" } });
  emit({ type: "item.updated", item });
  emit({ type: "item.completed", item });
}
emit({
  type: "turn.completed",
  usage: {
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 5,
    reasoning_output_tokens: 0,
  },
});
if (prompt.includes("[fixture:late-error]")) {
  process.stderr.write("private fixture stderr\n");
  process.exit(7);
}
