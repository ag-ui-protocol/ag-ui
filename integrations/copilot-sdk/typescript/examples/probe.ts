import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { verifyEvents } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { from, lastValueFrom, toArray } from "rxjs";

const url = new URL(process.env.COPILOT_AGENT_URL ?? "http://127.0.0.1:8028/agent");
assert(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Probe is loopback-only");
const health = await (await fetch(new URL("/health", url), { signal: AbortSignal.timeout(10_000) })).json();
assert(health.mode === "live" || health.native === true, "This probe requires native mode, never a fixture");
assert.notEqual(health.synthetic, true);
const selfContained = health.mode === "live";

async function run(input: RunAgentInput, terminal = "RUN_FINISHED"): Promise<BaseEvent[]> {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    signal: AbortSignal.timeout(120_000),
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split("\n\n").filter(Boolean)
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as BaseEvent);
  assert.equal(events[0]?.type, "RUN_STARTED");
  assert.equal(events.at(-1)?.type, terminal, JSON.stringify(events.at(-1)));
  await lastValueFrom(from(events).pipe(verifyEvents(), toArray()));
  return events;
}
const input = (content: string): RunAgentInput => ({
  threadId: randomUUID(), runId: randomUUID(), state: {}, context: [], forwardedProps: {}, tools: [],
  messages: [{ id: randomUUID(), role: "user", content }],
});
const chatInput = input("Reply with a brief greeting. Do not use tools.");
const frontendInput = input("Call browser_nonce exactly once. After it returns, include its exact nonce in your final answer. Do not invent a result.");
frontendInput.tools = [{
  name: "browser_nonce", description: "Read a fresh browser nonce.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
}];

try {
  const chat = await run(chatInput);
  assert(chat.some((event) => event.type === "TEXT_MESSAGE_CONTENT"));
  const handoff = await run(frontendInput);
  const call = handoff.find((event) => event.type === "TOOL_CALL_START" && event.toolCallName === "browser_nonce");
  assert(call);
  assert(handoff.some((event) => event.type === "TOOL_CALL_END" && event.toolCallId === call.toolCallId));
  assert(!handoff.some((event) => event.type === "TOOL_CALL_RESULT"));
  const nonce = randomUUID();
  const resumedInput: RunAgentInput = {
    ...frontendInput, runId: randomUUID(),
    messages: [
      ...frontendInput.messages,
      {
        id: String(call.parentMessageId ?? randomUUID()), role: "assistant", content: "",
        toolCalls: [{ id: String(call.toolCallId), type: "function", function: { name: "browser_nonce", arguments: "{}" } }],
      },
      { id: randomUUID(), role: "tool", toolCallId: String(call.toolCallId), content: JSON.stringify({ nonce }) },
    ],
  };
  const continuation = await run(resumedInput);
  const answer = continuation.filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join("");
  assert(answer.includes(nonce), "Original native session must consume the newly generated browser nonce");
  assert(!continuation.some((event) => event.type === "TOOL_CALL_RESULT"));
  const replay = await run({ ...resumedInput, runId: randomUUID() });
  assert.deepEqual(replay.map((event) => event.type), ["RUN_STARTED", "RUN_FINISHED"]);
  const conflict = await run({
    ...resumedInput, runId: randomUUID(),
    messages: resumedInput.messages.map((message) => message.role === "tool" ? { ...message, content: "changed answer" } : message),
  }, "RUN_ERROR");
  assert.equal(conflict.at(-1)?.code, "FRONTEND_TOOL_RESULT_CONFLICT");
  const wrongThread = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...resumedInput, threadId: randomUUID(), runId: randomUUID() }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(wrongThread.status, 409);
  await wrongThread.text();
  const directory = new URL("../evidence/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(selfContained ? "self-contained-native.json" : "standalone-native-http.json", directory), JSON.stringify({
    native: true, sdk: "1.0.14", checkedAt: new Date().toISOString(),
    independentOfSiblingCheckout: selfContained, chatPassed: true, continuationConsumedFreshNonce: true,
    frontendResultNotEchoed: true, exactReplayNoOp: true, changedAnswerConflict: true,
    wrongThreadRejected: true, pinnedVerifierPassed: true,
    traces: { chat, handoff, continuation, replay, conflict },
  }, null, 2) + "\n");
  console.log("PASS native chat, frontend continuation, verbatim replay, changed-answer conflict, wrong-thread rejection and pinned verifier");
} finally {
  await Promise.allSettled([chatInput.threadId, frontendInput.threadId].map((threadId) =>
    fetch(new URL("/agent/cancel", url), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId }),
      signal: AbortSignal.timeout(10_000),
    }),
  ));
}
