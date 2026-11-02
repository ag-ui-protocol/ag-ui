import { readFile, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { lastValueFrom, toArray } from "rxjs";
const { ClaudeAgentAdapter } = createRequire(import.meta.url)(
  "../src/adapter.ts",
);
const c = JSON.parse(await readFile(process.argv[2], "utf8"));
const adapter = new ClaudeAgentAdapter({
  queryTimeoutMs: 10000,
  cwd: c.root,
  env: c.env,
  settingSources: [],
  model: "claude-sonnet-4-6",
  tools: ["Agent", "SendMessage", "Read", "Write"],
  allowedTools: ["Agent", "SendMessage", "Write"],
  agents: c.agents ?? {
    verifier: {
      description: "Read fixture",
      prompt: "Read fixture only",
      tools: ["Read"],
    },
  },
  sessionId: c.phase === "start" ? c.session : undefined,
  nativeChildRecovery: {
    directory: c.root + "/config/projects",
    tools: ["Read"],
    timeoutMs: 1500,
    // The supervisor serializes these disposable workers. A production host must supply its exclusive lease.
    acquire: async () => async () => {},
    execute: async (call, key) => {
      if (
        call.name !== "Read" ||
        call.input.file_path !== c.root + "/fixture.txt"
      )
        throw Error("Unexpected tool");
      await appendFile(c.root + "/executions.log", key + "\n");
      return { content: await readFile(call.input.file_path, "utf8") };
    },
  },
});
const input = c.input ?? {
  threadId: "standalone",
  runId: crypto.randomUUID(),
  messages: [
    {
      id: crypto.randomUUID(),
      role: "user",
      content: "Read the fixture with a verifier child.",
    },
  ],
  tools: [],
  context: [],
  state: {},
  forwardedProps: c.phase === "start" ? {} : { resume: c.session },
  ...(c.phase === "answer"
    ? {
        resume: [
          {
            interruptId: "original_child0",
            status: "resolved",
            payload: { behavior: c.decision },
          },
        ],
      }
    : {}),
};
const events = await lastValueFrom(adapter.run(input).pipe(toArray()));
console.log("EVENTS " + JSON.stringify(events));
if (events.some((e) => e.type === "RUN_ERROR")) process.exitCode = 1;
