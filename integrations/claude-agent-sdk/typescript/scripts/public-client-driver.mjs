// Public HttpAgent/full-resume control. Optional real CPK core, never mutates pendingInterrupts.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { HttpAgent, buildResumeArray } from "@ag-ui/client";
const c = JSON.parse(await readFile(process.argv[2], "utf8"));
const agent = new HttpAgent({
  url: c.url,
  agentId: "fixture",
  threadId: c.session,
  initialMessages: c.messages,
});
let core;
const errors = [];
if (c.cpkCore) {
  const require = createRequire(c.cpkCore + "/package.json");
  const { CopilotKitCore } = require(c.cpkCore);
  const { z } = require("zod");
  core = new CopilotKitCore({});
  core.setTools(
    c.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters:
        t.name === "chart"
          ? z.object({ value: z.number() })
          : z.object({}).passthrough(),
      handler: async () => {
        throw Error("Unexpected automatic frontend execution");
      },
    })),
  );
  core.addContext(c.context[0]);
  core.subscribe({
    onError: ({ error }) => {
      errors.push(error.message);
    },
  });
}
const events = [];
agent.subscribe({
  onEvent: ({ event }) => {
    events.push(event);
  },
});
const run = async (resume) => {
  const options = {
    forwardedProps: { resume: c.session },
    ...(resume ? { resume } : {}),
  };
  if (core) await core.runAgent({ agent, ...options });
  else await agent.runAgent({ ...options, tools: c.tools, context: c.context });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(
    !events.some((e) => e.type === "RUN_ERROR"),
    JSON.stringify(events.filter((e) => e.type === "RUN_ERROR")),
  );
};
await run();
assert.deepEqual(
  new Set(agent.pendingInterrupts.map((i) => i.id)),
  new Set(["root-read", "leaf0", "leaf1"]),
);
assert.equal(
  agent.pendingInterrupts.find((i) => i.id === "leaf1").reason,
  "tool_call",
);
assert.ok(
  !agent.messages.some(
    (m) => m.role === "assistant" && m.toolCalls?.some((t) => t.id === "leaf1"),
  ),
  "Must exercise imported child-only call, not fabricated root call",
);
await assert.rejects(
  () =>
    agent.runAgent({
      forwardedProps: { resume: c.session },
      resume: [
        {
          interruptId: "root-read",
          status: "resolved",
          payload: { behavior: "allow" },
        },
      ],
    }),
  /not addressed/,
);
const actualResult = c.raw
  ? "FRONTEND_ACTUAL"
  : { status: "FRONTEND_ACTUAL", value: 7 };
const responses = Object.fromEntries(
  agent.pendingInterrupts.map((i) => [
    i.id,
    i.id === "leaf1"
      ? c.cancel
        ? { status: "cancelled" }
        : { status: "resolved", payload: actualResult }
      : { status: "resolved", payload: { behavior: "allow" } },
  ]),
);
const resume = buildResumeArray(agent.pendingInterrupts, responses);
// This is the public hook's result format: JSON payload plus a resume entry for EVERY ID.
for (const i of agent.pendingInterrupts.filter(
  (i) => i.reason === "tool_call",
)) {
  const response = responses[i.id];
  agent.addMessage({
    id: "frontend-" + i.id,
    role: "tool",
    toolCallId: i.toolCallId,
    content:
      c.raw && response.status !== "cancelled"
        ? response.payload
        : JSON.stringify(
            response.status === "cancelled"
              ? { status: "cancelled" }
              : (response.payload ?? { status: "resolved" }),
          ),
  });
}
await run(resume);
assert.equal(agent.pendingInterrupts.length, 0);
await run(resume); // lost-response retry: canonical results, no native execution again
await run(); // another fresh adapter host with full hydrated history
await writeFile(
  c.output,
  JSON.stringify(
    {
      passed: true,
      cpk: !!core,
      events,
      messages: agent.messages,
      standardResume: resume,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed: true,
    cpk: !!core,
    fullResume: true,
    partialRejected: true,
    output: c.output,
  }),
);
