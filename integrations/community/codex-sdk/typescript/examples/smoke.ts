import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpAgent } from "@ag-ui/client";

async function main() {
  if (process.env.CODEX_TEST_MODE)
    throw new Error(
      "Real provider smoke cannot run in controlled fixture mode.",
    );
  const url =
    process.env.AG_UI_SMOKE_URL ?? "http://127.0.0.1:8032/agentic_chat";
  const marker = `agui-${randomUUID()}`;
  const agent = new HttpAgent({ url, threadId: randomUUID() });
  let finished = 0;
  let failed = 0;
  agent.subscribe({
    onRunFinishedEvent() {
      finished++;
    },
    onRunErrorEvent() {
      failed++;
    },
  });
  agent.addMessage({
    id: randomUUID(),
    role: "user",
    content: `Remember this exact marker for the next question: ${marker}. Reply with only OK.`,
  });
  await agent.runAgent();
  agent.addMessage({
    id: randomUUID(),
    role: "user",
    content:
      "What exact marker did I ask you to remember? Reply with only that marker.",
  });
  await agent.runAgent();
  const answer = agent.messages.at(-1);
  assert(
    answer &&
      answer.role === "assistant" &&
      typeof answer.content === "string" &&
      answer.content.includes(marker),
    "Native conversation did not retain its marker.",
  );
  assert.equal(finished, 2);
  assert.equal(failed, 0);
  const isolated = new HttpAgent({ url, threadId: randomUUID() });
  isolated.addMessage({
    id: randomUUID(),
    role: "user",
    content:
      "What marker did I ask you to remember in this conversation? If none was provided, reply NONE.",
  });
  await isolated.runAgent();
  const other = isolated.messages.at(-1);
  assert(
    other &&
      "content" in other &&
      typeof other.content === "string" &&
      !other.content.includes(marker),
    "Independent native thread leaked context.",
  );
  const cancelled = new HttpAgent({ url, threadId: randomUUID() });
  cancelled.addMessage({
    id: randomUUID(),
    role: "user",
    content:
      "Write a detailed numbered list of 1000 different short sentences.",
  });
  const cancellation = cancelled.runAgent();
  const abort = setTimeout(() => cancelled.abortRun(), 500);
  try {
    await cancellation;
  } catch {
  } finally {
    clearTimeout(abort);
  }
  process.stdout.write(
    "Real provider two-turn continuation, separate-thread isolation and client cancellation completed. Verify owned process exit on the server host.\n",
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Provider smoke failed."}\n`,
  );
  process.exitCode = 1;
});
