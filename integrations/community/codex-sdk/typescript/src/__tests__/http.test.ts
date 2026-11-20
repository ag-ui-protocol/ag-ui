import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { CodexAgentAdapter } from "../index";
import { createCodexServer } from "../../examples/http";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function boot(options: { maxBodyBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ag-ui-codex-http-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const agent = new CodexAgentAdapter({
    codexOptions: {
      codexPathOverride: resolve("examples/testing/codex-exec.mjs"),
      env: {
        PATH: process.env.PATH ?? "",
        CODEX_TEST_MODE: "1",
        CODEX_FIXTURE_DIR: directory,
      },
    },
  });
  const server: Server = createCodexServer({ agent, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return { url: `http://127.0.0.1:${address.port}`, directory };
}
const input = (threadId = "thread", content = "Hello") => ({
  threadId,
  runId: crypto.randomUUID(),
  messages: [{ id: crypto.randomUUID(), role: "user", content }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

describe("standalone HTTP/SSE server", () => {
  it("uses HttpAgent to reconstruct two turns and isolates another conversation", async () => {
    const { url } = await boot();
    const agent = new HttpAgent({
      url: `${url}/agentic_chat`,
      threadId: "alice",
    });
    agent.addMessage({ id: "u1", role: "user", content: "My name is Alice" });
    await agent.runAgent();
    expect(agent.messages.filter((m) => m.role === "assistant")).toHaveLength(
      1,
    );
    agent.addMessage({ id: "u2", role: "user", content: "What is my name?" });
    await agent.runAgent();
    expect(agent.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Your name is Alice.",
    });
    const other = new HttpAgent({
      url: `${url}/agentic_chat`,
      threadId: "other",
    });
    other.addMessage({
      id: "other-user",
      role: "user",
      content: "What is my name?",
    });
    await other.runAgent();
    expect(other.messages.at(-1)).toMatchObject({
      content: "I do not know your name.",
    });
  });
  it("rejects bad JSON, schema, body size and unrelated browser origins before streaming", async () => {
    const { url } = await boot({ maxBodyBytes: 512 });
    const post = (body: string, origin?: string) =>
      fetch(`${url}/agentic_chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body,
      });
    expect((await post("{")).status).toBe(400);
    expect((await post("{}")).status).toBe(400);
    expect((await post("x".repeat(1024))).status).toBe(413);
    expect(
      (await post(JSON.stringify(input()), "https://unrelated.example")).status,
    ).toBe(403);
    const preflight = await fetch(`${url}/agentic_chat`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
  });
  it("sanitizes fatal SDK failures and late process errors into one terminal", async () => {
    const { url } = await boot();
    for (const marker of [
      "[fixture:error]",
      "[fixture:malformed]",
      "[fixture:late-error]",
    ]) {
      const response = await fetch(`${url}/agentic_chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input(marker, marker)),
      });
      const text = await response.text();
      expect(text.match(/RUN_ERROR/g)).toHaveLength(1);
      expect(text).not.toContain("RUN_FINISHED");
      expect(text).not.toContain("private fixture");
    }
  });
  it("aborts its owned SDK process when the response disconnects", async () => {
    const { url, directory } = await boot();
    const controller = new AbortController();
    const response = await fetch(`${url}/agentic_chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input("disconnect", "[fixture:hang]")),
    });
    expect(response.status).toBe(200);
    let pid: number | undefined;
    await expect
      .poll(
        async () => {
          try {
            const invocation = JSON.parse(
              await readFile(join(directory, "invocation.json"), "utf8"),
            );
            pid = invocation.pid;
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 3000 },
      )
      .toBe(true);
    controller.abort();
    await expect
      .poll(
        () => {
          try {
            if (pid === undefined) return true;
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
});
