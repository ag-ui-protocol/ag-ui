// Real registered CPK handlers; explicit public resume while CPK automatic reconciliation is separate work.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { HttpAgent, buildResumeArray } from "@ag-ui/client";
const c = JSON.parse(await readFile(process.argv[2], "utf8"));
const require = createRequire(c.cpkCore + "/package.json");
const { CopilotKitCore } = require(c.cpkCore);
const { z } = require("zod");
const agent = new HttpAgent({
  url: c.url,
  agentId: "registered-root",
  threadId: c.session,
  initialMessages: [
    { id: "prompt", role: "user", content: "Render two charts." },
  ],
});
const core = new CopilotKitCore({});
let executions = 0;
const errors = [];
const events = [];
core.setTools([
  {
    name: "chart",
    description: "Registered chart",
    parameters: z.object({ value: z.number() }),
    followUp: false,
    handler: async () => {
      executions++;
      return "";
    },
  },
]);
core.addContext({
  description: "registered root context",
  value: "REGISTERED_ROOT_CONTEXT",
});
core.subscribe({ onError: ({ error }) => errors.push(error.message) });
agent.subscribe({ onEvent: ({ event }) => events.push(event) });
await core.runAgent({ agent });
assert.equal(executions, 2);
assert.deepEqual(agent.pendingInterrupts.map((i) => i.id).sort(), [
  "parallel0",
  "parallel1",
]);
assert.ok(
  agent.pendingInterrupts.every(
    (i) => i.reason === "tool_call" && i.metadata.childId === "",
  ),
);
const existing = agent.messages.filter((m) => m.role === "tool");
assert.equal(existing.length, 2);
assert.ok(existing.every((m) => m.content === ""));
const resume = buildResumeArray(
  agent.pendingInterrupts,
  Object.fromEntries(
    agent.pendingInterrupts.map((i) => [
      i.id,
      {
        status: "resolved",
        payload: existing.find((m) => m.toolCallId === i.toolCallId).content,
      },
    ]),
  ),
);
// No new messages and no pendingInterrupts mutation: submit existing actual outcomes once.
for (const response of [resume, resume, undefined])
  await core.runAgent({
    agent,
    forwardedProps: { resume: c.session },
    ...(response ? { resume: response } : {}),
  });
assert.deepEqual(errors, []);
assert.ok(!events.some((e) => e.type === "RUN_ERROR"));
assert.equal(executions, 2);
assert.equal(agent.pendingInterrupts.length, 0);
for (const old of existing) {
  const current = agent.messages.filter(
    (m) => m.role === "tool" && m.toolCallId === old.toolCallId,
  );
  assert.equal(current.length, 1);
  assert.equal(current[0].id, old.id);
  assert.equal(current[0].content, "");
}
await writeFile(
  c.output,
  JSON.stringify(
    {
      passed: true,
      handlerExecutions: executions,
      explicitFullResume: true,
      automaticContinuationVerified: false,
      events,
      messages: agent.messages,
    },
    null,
    2,
  ),
);
