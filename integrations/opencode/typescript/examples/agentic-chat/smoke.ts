/** Real-server smoke: requires OPENCODE_URL, OPENCODE_DIRECTORY and a configured model. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  OpenCodeBridge,
  createSdkTransport,
  FileSessionStore,
} from "../../src/server";
import type { BaseEvent } from "@ag-ui/core";

async function main() {
  if (!process.env.OPENCODE_URL)
    throw new Error(
      "Set OPENCODE_URL to a running OpenCode server with a configured model",
    );
  const directory = resolve(process.env.OPENCODE_DIRECTORY ?? process.cwd());
  const folder = await mkdtemp(join(tmpdir(), "opencode-ag-ui-smoke-"));
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const transport = createSdkTransport({
    baseUrl: process.env.OPENCODE_URL,
    directory,
    headers: password
      ? {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        }
      : undefined,
  });
  const bridge = new OpenCodeBridge({
    transport,
    store: new FileSessionStore(folder),
    directory,
  });
  const threadId = randomUUID();
  const messages: Array<{ id: string; role: "user"; content: string }> = [];
  try {
    for (const content of [
      "Say hello in one short sentence.",
      "What did I just ask you to do?",
    ]) {
      messages.push({ id: randomUUID(), role: "user", content });
      const events: BaseEvent[] = [];
      await bridge.run(
        { threadId, runId: randomUUID(), messages, tools: [], context: [] },
        { directory, owner: "smoke-test" },
        (event) => {
          events.push(event);
          console.log(JSON.stringify(event));
        },
      );
      if (
        events.at(-1)?.type !== "RUN_FINISHED" ||
        (events.at(-1)?.outcome as { type: string })?.type !== "success"
      )
        throw new Error("Real-server smoke did not complete successfully");
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
