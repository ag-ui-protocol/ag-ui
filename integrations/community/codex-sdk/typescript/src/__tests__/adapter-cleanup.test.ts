import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lastValueFrom, tap, toArray } from "rxjs";
import { EventType } from "@ag-ui/core";
import { CodexAgentAdapter } from "../adapter";
import { MemoryCodexSessionStore } from "../sessions";

const children: number[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("owned SDK process cleanup", () => {
  it.each(["oversized", "malformed", "resistant"])(
    "waits for delayed SIGTERM exit before terminal and admission release for %s output",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "ag-ui-codex-cleanup-"));
      directories.push(directory);
      const executable = join(directory, "codex.mjs");
      const pidFile = join(directory, "pid");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.PID_FILE, String(process.pid));
process.on('SIGTERM', () => ${mode === "resistant" ? "{}" : "setTimeout(() => process.exit(0), 300)"});
for await (const chunk of process.stdin) {}
${mode === "malformed" ? "process.stdout.write('invalid native JSON\\n');" : "process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'delayed'})+'\\n');process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',id:'a',text:'oversized text'}})+'\\n');"}
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      const store = new MemoryCodexSessionStore();
      const agent = new CodexAgentAdapter({
        sessionStore: store,
        maxTextBytes: 2,
        codexOptions: {
          codexPathOverride: executable,
          env: { PATH: process.env.PATH ?? "", PID_FILE: pidFile },
        },
      });
      let aliveAtTerminal = false;
      let terminalCount = 0;
      const events = await lastValueFrom(
        agent
          .run({
            threadId: "thread",
            runId: "run",
            messages: [{ id: "u", role: "user", content: "Hello" }],
            tools: [],
            context: [],
          })
          .pipe(
            tap((event) => {
              if (
                event.type === EventType.RUN_ERROR ||
                event.type === EventType.RUN_FINISHED
              ) {
                const pid = Number(readFileSync(pidFile, "utf8"));
                children.push(pid);
                aliveAtTerminal = alive(pid);
                terminalCount++;
              }
            }),
            toArray(),
          ),
      );
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR });
      expect(terminalCount).toBe(1);
      expect(aliveAtTerminal).toBe(false);
      expect(() => store.acquire("thread")).not.toThrow();
      store.release("thread");
    },
  );
  it("stops an orphan descendant that retains the native output pipe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ag-ui-codex-orphan-"));
    directories.push(directory);
    const executable = join(directory, "codex.mjs");
    const pidFile = join(directory, "pid");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
writeFileSync(process.env.PID_FILE, String(descendant.pid));
for await (const chunk of process.stdin) {}
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'orphan'})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',id:'a',text:'OK'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}})+'\\n');
process.exit(0);
`,
      { mode: 0o755 },
    );
    const agent = new CodexAgentAdapter({
      codexOptions: {
        codexPathOverride: executable,
        env: { PATH: process.env.PATH ?? "", PID_FILE: pidFile },
      },
    });
    const events = await lastValueFrom(
      agent
        .run({
          threadId: "orphan",
          runId: "orphan-run",
          messages: [{ id: "u", role: "user", content: "Hello" }],
          tools: [],
          context: [],
        })
        .pipe(toArray()),
    );
    const descendant = Number(readFileSync(pidFile, "utf8"));
    children.push(descendant);
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect(alive(descendant)).toBe(false);
  });
});
