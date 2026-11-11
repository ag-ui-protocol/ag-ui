import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodex, type CodexClient } from "../sdk";

const directories: string[] = [];
const clients: CodexClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose?.()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function client() {
  const directory = await mkdtemp(join(tmpdir(), "ag-ui-codex-sdk-"));
  directories.push(directory);
  const codex = await createCodex({
    codexPathOverride: resolve("examples/testing/codex-exec.mjs"),
    env: {
      PATH: process.env.PATH ?? "",
      CODEX_TEST_MODE: "1",
      CODEX_FIXTURE_DIR: directory,
    },
  });
  clients.push(codex);
  return { codex, directory };
}

describe("the installed official SDK", () => {
  it("launches lazily and resumes the native conversation with fresh input", async () => {
    const { codex, directory } = await client();
    const first = codex.startThread({ sandboxMode: "read-only" });
    const events = (await first.runStreamed("My name is Alice")).events;
    for await (const event of events) expect(event.type).toBeTypeOf("string");
    expect(first.id).toBeTruthy();
    const second = codex.resumeThread(first.id ?? "");
    const replies: string[] = [];
    for await (const event of (await second.runStreamed("What is my name?"))
      .events) {
      if (
        event.type === "item.completed" &&
        event.item.type === "agent_message"
      )
        replies.push(event.item.text);
    }
    expect(replies).toEqual(["Your name is Alice."]);
    const invocation = JSON.parse(
      await readFile(join(directory, "invocation.json"), "utf8"),
    );
    expect(invocation.args).toContain("resume");
    expect(invocation.args).toContain(first.id);
    expect(invocation.prompt).toBe("What is my name?");
  });
  it("terminates its controlled child on abort", async () => {
    const { codex, directory } = await client();
    const controller = new AbortController();
    const events = (
      await codex
        .startThread()
        .runStreamed("[fixture:hang]", { signal: controller.signal })
    ).events;
    const started = await events.next();
    expect(started.value?.type).toBe("thread.started");
    const { pid } = JSON.parse(
      await readFile(join(directory, "invocation.json"), "utf8"),
    );
    controller.abort();
    try {
      for await (const _event of events) {
        void _event;
      }
    } catch {}
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 3000 },
      )
      .toBe(false);
  });
  it("reports malformed JSON and a nonzero exit after completion", async () => {
    const { codex } = await client();
    for (const prompt of ["[fixture:malformed]", "[fixture:late-error]"]) {
      const drain = async () => {
        for await (const _event of (
          await codex.startThread().runStreamed(prompt)
        ).events) {
          void _event;
        }
      };
      await expect(drain()).rejects.toThrow();
    }
  });
});
